"""Python 参考实现：RINEX 3.04 解析 + 星历传播 + 机体系 LOS + PDOP。

用途：作为 gnss_pdop_tool.html 中 JavaScript 实现的**独立数值基准**。
两套实现刻意用不同语言、不同写法各写一遍，互为交叉验证：
test_core.js 会把 JS 的输出与本文件的输出逐历元比对，任何一侧算错都会暴露。

    python reference/ref_pdop.py            # 打印基准统计
    python reference/ref_pdop.py --dump     # 逐历元导出 JSON 到 build/

路径相对本文件解析，仓库任意位置调用都能跑。

约定：
    Yaw   罗盘方位，北偏西为正（正西 = +90）
    Pitch 抬头为正
    Roll  右滚为正（右翼下）
    机体  X-右 / Y-前 / Z-上（= 天线面法线）
    C_enu^b = Ry(-roll) . Rx(-pitch) . Rz(-yaw)
    Height 直接当椭球高用
"""
import csv
import datetime
import json
import math
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MU = 3.986005e14          # 地球引力常数 m^3/s^2
WE = 7.2921151467e-5      # 地球自转角速度 rad/s
CLIGHT = 299792458.0
WGS_A = 6378137.0
WGS_F = 1 / 298.257223563
WGS_E2 = WGS_F * (2 - WGS_F)
GPS_EPOCH = datetime.date(1980, 1, 6)

KEP = ("G", "E", "C", "J", "I")          # 注意：必须用 tuple/list 判成员，
NL = {"G": 8, "J": 8, "E": 8, "C": 8, "I": 8, "R": 4, "S": 4}   # 'S' in 'GREJCIS' 为真！

# 广播星历有效期窗（秒），与 gnss_pdop_tool.html 的 EPH_MAX_AGE 保持一致。
# 两个方向都要卡：向后是记录太陈旧，向前是 t 早于该星首条电文。
# 后处理允许小范围向前外推，所以不是禁掉而是加窗 —— 没有上界时，
# 换一份首条电文晚数小时的星历就会静默外推数小时且毫无提示。
MAX_AGE = 7200

RNX = os.path.join(ROOT, "samples", "rnx", "BRDM00DLR_S_20262690000_01D_MN.rnx")
CSVF = os.path.join(ROOT, "samples", "traces", "flight_shanghai_xian_5000.csv")
DUMP = os.path.join(ROOT, "build", "ref_all15.json")


def f19(s, i):
    """RINEX 3.04 定宽 D19.12 字段；0-based 下标 i。全空 = 未定义 -> NaN。"""
    t = s[i:i + 19].strip()
    return float(t.replace("D", "E").replace("d", "E")) if t else float("nan")


def fld1(s, i):
    """第 1 行历元：0-based 下标 i 起一个 19 字符整块 -> 自 1980 起的 UTC 秒。"""
    p = s[i:i + 19].split()
    if len(p) < 6:
        return None
    y, mo, d, h, mi, se = (int(x) for x in p[:6])
    days = (datetime.date(y, mo, d) - GPS_EPOCH).days
    frac = float(p[6]) if len(p) > 6 else 0.0
    return days * 86400 + h * 3600 + mi * 60 + se + frac


def parse_rinex(path):
    lines = open(path, encoding="ascii").read().split("\n")
    leap = 18
    sats = {}
    i = 0
    while i < len(lines):
        if lines[i][60:80].strip() == "LEAP SECONDS":
            leap = int(float(lines[i][0:6]))
        m = re.match(r"^([GREJCIS])(\d\d) 20", lines[i])
        if not m:
            i += 1
            continue
        s, pn = m.group(1), m.group(2)
        n = NL[s]
        b = lines[i:i + n]
        if len(b) < n:
            i += 1
            continue
        toc = fld1(b[0], 4)
        if toc is None:
            i += 1
            continue
        if s in KEP:
            # G/E/C/J/I 的 L1-L6 布局完全同构
            g = lambda k, j: f19(b[k], j)
            # BROADCAST ORBIT 1 = IODE | Crs | Δn | M0，Crs 在第 2 格而非历元行
            r = dict(dn=g(1, 42), M0=g(1, 61), Crs=g(1, 23),
                     Cuc=g(2, 4), e=g(2, 23), Cus=g(2, 42), sqA=g(2, 61),
                     toe=g(3, 4), Cic=g(3, 23), Om0=g(3, 42), Cis=g(3, 61),
                     i0=g(4, 4), Crc=g(4, 23), om=g(4, 42), dOm=g(4, 61),
                     dI=g(5, 4), wk=g(5, 42))
            if not math.isfinite(r["dI"]):
                r["dI"] = 0.0
            # BDS 的 week 是 BDT 周号 -> GPS 周 = +1356
            w = r["wk"] if math.isfinite(r["wk"]) else 0.0
            r["t_abs"] = r["toe"] + (w + (1356 if s == "C" else 0)) * 604800.0
            r["kind"] = "kep"
        else:
            # GLONASS / SBAS：X,Y,Z 在第 2/3/4 行；历元按 UTC -> 加闰秒
            r = dict(X=f19(b[1], 4), Xd=f19(b[1], 23), Xdd=f19(b[1], 42),
                     Y=f19(b[2], 4), Yd=f19(b[2], 23), Ydd=f19(b[2], 42),
                     Z=f19(b[3], 4), Zd=f19(b[3], 23), Zdd=f19(b[3], 42))
            for k in ("Xd", "Yd", "Zd", "Xdd", "Ydd", "Zdd"):
                if not math.isfinite(r[k]):
                    r[k] = 0.0
            r["t_abs"] = toc + leap
            r["kind"] = "cart"
        sats.setdefault(s + pn, (s, pn, []))[2].append(r)
        i += n
    out = []
    for s, pn, recs in sats.values():
        recs.sort(key=lambda r: r["t_abs"])
        out.append((s, pn, recs))
    out.sort(key=lambda x: x[0] + x[1])
    return out, leap


def pick(sat, t, max_age=MAX_AGE):
    """取 t_abs <= t 中最新的一条；没有则回退到最早一条做向前外推。

    两种回退/选中都必须落在 ±max_age 窗内，超窗返回 None —— 调用方按该星
    该历元不可用处理。max_age=None 退化为旧行为（不设门限）。
    """
    prev = None
    for r in sat[2]:
        if r["t_abs"] <= t:
            prev = r
        else:
            break
    rec = prev if prev is not None else sat[2][0]
    if max_age is not None:
        age = t - rec["t_abs"]          # >0 陈旧，<0 超前
        if age > max_age or -age > max_age:
            return None
    return rec


def propagate(s, r, t):
    if r["kind"] == "cart":
        tau = t - r["t_abs"]
        return ((r["X"] + r["Xd"] * tau + 0.5 * r["Xdd"] * tau * tau) * 1000,
                (r["Y"] + r["Yd"] * tau + 0.5 * r["Ydd"] * tau * tau) * 1000,
                (r["Z"] + r["Zd"] * tau + 0.5 * r["Zdd"] * tau * tau) * 1000)
    # 开普勒广播星历。BDS 也走这条路径 —— i0=3*n0-π/2 的 GEO 规则对本文件有害。
    a = r["sqA"] ** 2
    tk = t - r["t_abs"]
    n = math.sqrt(MU / a ** 3) + r["dn"]
    M = r["M0"] + n * tk
    E = M
    for _ in range(12):
        E = M + r["e"] * math.sin(E)
    s2, c2 = math.sin(2 * E), math.cos(2 * E)
    # 幅角 u = ω + ν + δu。ν 是真近点角，漏掉它卫星会被冻结在轨道上固定一点。
    nu = math.atan2(math.sqrt(1 - r["e"] ** 2) * math.sin(E), math.cos(E) - r["e"])
    u = r["om"] + nu + (r["Cus"] * s2 + r["Cuc"] * c2)
    dR = r["Crs"] * s2 + r["Crc"] * c2
    di = r["Cis"] * s2 + r["Cic"] * c2
    inc = r["i0"] + di + tk * r["dI"]
    R = a * (1 - r["e"] * math.cos(E)) + dR
    O = (r["Om0"] + (r["dOm"] - WE) * tk - WE * r["toe"]) % (2 * math.pi)
    uu = u % (2 * math.pi)
    return (R * math.cos(O) * math.cos(uu) - R * math.sin(O) * math.sin(uu) * math.cos(inc),
            R * math.sin(O) * math.cos(uu) + R * math.cos(O) * math.sin(uu) * math.cos(inc),
            R * math.sin(uu) * math.sin(inc))


def ecef(lat, lon, h):
    la, lo = math.radians(lat), math.radians(lon)
    sl = math.sin(la)
    cl = math.cos(la)
    N = WGS_A / math.sqrt(1 - WGS_E2 * sl * sl)
    # 水平分量用 cos(纬度)、垂直分量用 sin(纬度)：地纬从赤道面量起
    return ((N + h) * cl * math.cos(lo), (N + h) * cl * math.sin(lo), (N * (1 - WGS_E2) + h) * sl)


def mm(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def dcm(yaw, pitch, roll):
    """ENU -> Body。C_enu^b = Ry(-roll) . Rx(-pitch) . Rz(-yaw)；行 = 机体系轴在 ENU 中的表示。"""
    cy, sy = math.cos(yaw), math.sin(yaw)
    ct, st = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    return mm(mm([[cr, 0, -sr], [0, 1, 0], [sr, 0, cr]],
                 [[1, 0, 0], [0, ct, st], [0, -st, ct]]),
              [[cy, sy, 0], [-sy, cy, 0], [0, 0, 1]])


def pdop(Q, C):
    """增广 [A|I] 高斯-约当 + 部分主元。原地法会静默退化成单位阵，务必用本式。

    C 是姿态 DCM（ENU->Body，行 = 机体系轴在 ENU 中的表示）。
    """
    A = [[0.0] * 8 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            A[i][j] = Q[i * 4 + j]
        A[i][4 + i] = 1.0
    for k in range(4):
        pv = max(range(k, 4), key=lambda r: abs(A[r][k]))
        if abs(A[pv][k]) < 1e-12:
            return float("nan")
        A[k], A[pv] = A[pv], A[k]
        d = A[k][k]
        A[k] = [x / d for x in A[k]]
        for r in range(4):
            if r != k:
                f = A[r][k]
                A[r] = [A[r][j] - f * A[k][j] for j in range(8)]
    # 法方程的未知量顺序是 [钟差, x, y, z]，所以 (HᵀH)⁻¹ 的对角元依次是
    # 钟差方差、q_xx、q_yy、q_zz。PDOP **不含钟差**。
    # 早先这里写的是 A[0][4]+A[1][5]+A[2][6]，含了钟差又漏了 q_zz，
    # 既不是 PDOP 也不是 GDOP，结果系统性偏大约 1.62~1.75 倍。
    # 若需要 GDOP，是 A[0][4]+A[1][5]+A[2][6]+A[3][7]（四项全取）。
    #
    # 参考系：法方程的行是**机体系**视线矢量，所以解出来的位置块也是机体系的，
    # 而 PDOP 按定义是**当地 ENU 水平**的量。必须 Cov_enu = Cᵀ·Cov_body·C
    # 转过去再合成。早先直接取机体系 x/y 的对角元，等价于假设天线面板始终水平 ——
    # 本仓库样本 roll 最大到 54.3°，单历元能差到 88%。
    # 水平合成取 sqrt(EE + NN + 2·EN)，与 accuracySolve 的 σ_h 同一个式子。
    P = [[A[1][5], A[1][6], A[1][7]],
         [A[2][5], A[2][6], A[2][7]],
         [A[3][5], A[3][6], A[3][7]]]
    # R = Cᵀ · P · C（行优先展平后复用同一个循环）
    R = [[sum(C[k][i] * P[k][l] * C[l][j] for k in range(3) for l in range(3))
          for j in range(3)] for i in range(3)]
    v = R[0][0] + R[1][1] + 2 * R[0][1]
    return math.sqrt(v) if v > 0 else float("nan")


def solve(rows, sats, t0, mask, sel=None):
    thr = math.sin(math.radians(mask))
    per = []
    tot = 0
    sp = np_ = 0
    nmin, nmax, pmin, pmax = 1e9, -1, 1e9, -1e9
    tot_drop = 0      # 全程因超出 ±MAX_AGE 而被判不可用的 (历元,星) 次数
    for row in rows:
        t = t0 + float(row["Time"])
        lat = float(row["Latitude"])
        lon = float(row["Longitude"])
        rx = ecef(lat, lon, float(row["Height"]))
        C = dcm(math.radians(float(row["Yaw"])),
                math.radians(float(row["Pitch"])),
                math.radians(float(row["Roll"])))
        # ECEF -> ENU 需要站点经度 λ₀ 与纬度 φ₀
        sl, cl = math.sin(math.radians(lon)), math.cos(math.radians(lon))
        sf, cf = math.sin(math.radians(lat)), math.cos(math.radians(lat))
        Q = [0.0] * 16
        n = 0
        for sat in sats:
            if sel and sat[0] not in sel:
                continue
            r = pick(sat, t)
            if r is None:
                tot_drop += 1
                continue
            p = propagate(sat[0], r, t)
            dx, dy, dz = p[0] - rx[0], p[1] - rx[1], p[2] - rx[2]
            rho = math.sqrt(dx * dx + dy * dy + dz * dz)
            w = WE * (rho / CLIGHT)              # Sagnac：只取信号飞行时间，不是绝对时刻
            cw, sw = math.cos(w), math.sin(w)
            x1, y1 = dx * cw + dy * sw, -dx * sw + dy * cw
            E = -x1 * sl + y1 * cl
            N = -x1 * sf * cl - y1 * sf * sl + dz * cf
            U = x1 * cf * cl + y1 * cf * sl + dz * sf
            xb = (C[0][0] * E + C[0][1] * N + C[0][2] * U) / rho
            yb = (C[1][0] * E + C[1][1] * N + C[1][2] * U) / rho
            zb = (C[2][0] * E + C[2][1] * N + C[2][2] * U) / rho
            if zb <= thr:                        # 相对天线面法线的高度角截止
                continue
            if U <= 0:                           # 地平线以下：地球遮挡，天线朝哪都没用
                continue
            n += 1
            Q[0] += 1; Q[1] += xb; Q[2] += yb; Q[3] += zb
            Q[4] += xb; Q[5] += xb * xb; Q[6] += xb * yb; Q[7] += xb * zb
            Q[8] += yb; Q[9] += yb * xb; Q[10] += yb * yb; Q[11] += yb * zb
            Q[12] += zb; Q[13] += zb * xb; Q[14] += zb * yb; Q[15] += zb * zb
        v = pdop(Q, C) if n >= 4 else float("nan")
        per.append((n, v))
        tot += n
        nmin, nmax = min(nmin, n), max(nmax, n)
        if n >= 4:
            sp += v; np_ += 1
            pmin, pmax = min(pmin, v), max(pmax, v)
    N = len(rows)
    nsel = sum(1 for s in sats if not sel or s[0] in sel)
    return dict(mean=tot / N, nmin=nmin, nmax=nmax, pmean=sp / N,
                pmin=pmin, pmax=pmax, per=per,
                drop=(tot_drop / (N * nsel)) if nsel else 0.0)


def main():
    sats, leap = parse_rinex(RNX)
    rows = list(csv.DictReader(open(CSVF, encoding="utf-8-sig")))
    # 首条电文的历元 = 轨迹 Time 的锚点（轨迹本身没有绝对日期）
    head = open(RNX, encoding="ascii").readlines()
    for ln in head:
        m = re.match(r"^[GREJCIS]\d\d (\d\d\d\d) (\d\d) (\d\d) (\d\d) (\d\d) (\d\d)", ln)
        if m:
            y, mo, d, h, mi, se = (int(x) for x in m.groups())
            days = (datetime.date(y, mo, d) - GPS_EPOCH).days
            t0 = days * 86400 + h * 3600 + mi * 60 + se + leap
            break
    else:
        raise SystemExit("未找到首条电文历元")
    print("星数 %d，闰秒 %d，t0 = %.1f，轨迹 %d 行" % (len(sats), leap, t0, len(rows)))
    print("\n%-16s %-24s %-30s" % ("case", "n min~max mean", "PDOP min~max mean"))
    for nm, sel in [("all 7", None), ("GPS only", ("G",)), ("BDS only", ("C",)),
                    ("GPS+BDS", ("G", "C")), ("GPS+BDS+GAL", ("G", "C", "E"))]:
        r = solve(rows, sats, t0, 15.0, sel)
        print("%-16s %2d~%-2d mean %7.3f        %7.4f~%8.4f mean %7.4f"
              % (nm, r["nmin"], r["nmax"], r["mean"], r["pmin"], r["pmax"], r["pmean"]))
    print("\n掩角扫描（全部 7 系统）")
    for m in (0, 5, 10, 15, 20, 30, 45):
        r = solve(rows, sats, t0, float(m))
        print("  mask %2d  n mean %7.3f  PDOP mean %8.4f  max %9.4f"
              % (m, r["mean"], r["pmean"], r["pmax"]))
    r = solve(rows, sats, t0, 15.0)
    print("\n抽样历元 0/125/250/375 (all7, mask15): " + " ".join("%d/%.4f" % r["per"][i] for i in (0, 125, 250, 375)))
    if "--dump" in sys.argv:
        os.makedirs(os.path.dirname(DUMP), exist_ok=True)
        json.dump([(n, None if math.isnan(v) else v) for n, v in r["per"]],
                  open(DUMP, "w"))
        print("已写出 build/ref_all15.json")


if __name__ == "__main__":
    main()
