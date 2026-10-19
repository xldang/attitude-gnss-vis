/* 广播星历颗粒度与精度诊断。
 *
 *   node test/tools/eph_probe.js                 # 扫 samples/rnx/*.rnx 出报告
 *   node test/tools/eph_probe.js <file.rnx> ...  # 只看指定文件
 *   node test/tools/eph_probe.js --json <out>    # 同时落一份机读基线
 *
 * 为什么要有这个工具：星历的「采样间隔」和轨迹的「时间步长」是两件事。
 * 广播星历不是按时间采样的位置序列，而是一组在数小时窗口内有效的轨道根数；
 * propagate() 是解析式，对任意 t 直接求值，没有插值、没有查表、没有数值微分。
 * 所以「2 小时一条记录」这个颗粒度对 100 ms 步长不构成任何约束 ——
 * 本工具把这句话变成可复核的数字，而不是留给记忆。
 *
 * 精度是怎么估的：广播星历没有真值可比，但同一条星的两条**相邻的独立电文**
 * 是对同一轨道的两次独立描述。把两条各自外推到同一时刻 t，位置差 |p_A(t)-p_B(t)|
 * 是传播误差的代理量（真误差被夹在两者之间）。本工具所有误差数字都是这个口径。
 *
 * 所有路径相对本文件解析，仓库任意位置调用都能跑。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = path.join(ROOT, 'gnss_pdop_tool.html');
const RNXDIR = path.join(ROOT, 'samples', 'rnx');

/* ---------- 抽出 DOM-free 的算法核，和 test_core.js 同一套做法 ----------
 * 这里刻意不另写一份解析/传播实现：仓库里已经有 HTML 内核与 reference/ref_pdop.py
 * 两份，test_core.js 负责让它们互相对齐。第三份只会让「两份必须同步」的约束失效 ——
 * 而那个约束正是靠 adjacent-message 自洽测试守住的。测的就是出货代码本身。 */
const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/<script id="gnss-core">([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 <script id="gnss-core">'); process.exit(1); }
if (/\bdocument\b|\bwindow\b/.test(m[1])) {
  console.error('核心脚本引用了 DOM —— 违反 DOM-free 约束'); process.exit(1);
}
(0, eval)(m[1]);
const C = globalThis.GNSSCore;

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const jsonAt = argv.indexOf('--json');
const JSON_OUT = jsonAt >= 0 ? (argv[jsonAt + 1] || path.join(ROOT, 'build', 'eph_probe.json')) : null;
// --json 的值槽只有在 --json 真的出现时才跳过；否则 jsonAt+1 == 0 会把第一个文件参数吃掉
const FILE_ARGS = argv.filter((a, i) => a !== '--json' && !(jsonAt >= 0 && i === jsonAt + 1));
const FILES = (FILE_ARGS.length ? FILE_ARGS
  : fs.readdirSync(RNXDIR).filter(f => /\.rnx$/i.test(f)).sort().map(f => path.join(RNXDIR, f)))
  .map(f => path.isAbsolute(f) ? f : path.join(ROOT, f));

/* 100 ms 是本次要评估的候选步长；OFFSETS 是距 toe 的取样点（秒） */
const DT = 0.1;
const OFFSETS = [0, 900, 1800, 3600, 5400, 7200];

const stat = a => {
  const v = a.slice().sort((x, y) => x - y);
  const at = p => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  return { n: v.length, med: v[v.length >> 1], p90: at(0.9), max: v[v.length - 1],
           mean: v.reduce((a, b) => a + b, 0) / v.length };
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const pad = (x, w) => String(x).padStart(w);

/* ---------- 载入 ---------- */
console.log('=== 星历文件 ===');
const sats = new Map();          // key -> {sys, prn, recs:[...]}
const headers = [];
for (const fpath of FILES) {
  const r = C.parseRinex(fs.readFileSync(fpath, 'utf8'));
  headers.push({ file: path.basename(fpath), leap: r.header.leap, version: r.header.version,
                 sats: r.sats.length, records: r.nRecords, dup: r.nDup });
  console.log(`  ${path.basename(fpath).padEnd(40)} ${r.header.version}  ` +
              `${r.sats.length} 星  ${r.nRecords} 条  闰秒=${r.header.leap}  去重=${r.nDup}`);
  // 跨文件续接：同一颗星把 recs 拼起来再排序，否则文件边界处的间隔会被算成断档
  for (const s of r.sats) {
    const k = s.key;
    if (!sats.has(k)) sats.set(k, { sys: s.sys, prn: s.prn, key: k, recs: [] });
    sats.get(k).recs.push(...s.recs);
  }
}
for (const s of sats.values()) {
  s.recs.sort((a, b) => a.tAbs - b.tAbs);
  const out = [];
  for (const r of s.recs) if (!out.length || Math.abs(out[out.length - 1].tAbs - r.tAbs) > 1e-6) out.push(r);
  s.recs = out;
}
const list = [...sats.values()];
const KEP = list.filter(s => s.recs.length && s.recs[0].kind === 'kep');
const bySys = {};
for (const s of list) (bySys[s.sys] = bySys[s.sys] || []).push(s);
const SYSS = C.SYS_ORDER.filter(x => bySys[x] && bySys[x].length);

console.log('\n=== 概览 ===');
console.log(`  文件 ${FILES.length} 个  卫星 ${list.length} 颗  开普勒记录 ${KEP.reduce((a, s) => a + s.recs.length, 0)} 条`);
console.log(`  EPH_MAX_AGE = ${C.EPH_MAX_AGE} s（selectEph 的有效窗口，前后各判一次）`);

/* ---------- 1. 记录间隔 ---------- */
console.log('\n=== 记录间隔（同一颗星相邻两条电文 toe 的差） ===');
console.log(`  ${'系'.padEnd(4)}${'星数'.padStart(5)}${'中位'.padStart(9)}${'最小'.padStart(8)}` +
            `${'最大'.padStart(9)}   最常见间隔（秒:次数）`);
const gaps = {};
for (const sys of SYSS) {
  const d = [];
  for (const s of bySys[sys]) {
    for (let i = 1; i < s.recs.length; i++) {
      const g = s.recs[i].tAbs - s.recs[i - 1].tAbs;
      if (g > 0) d.push(g);
    }
  }
  if (!d.length) continue;
  gaps[sys] = d;
  const tally = {};
  for (const g of d) { const k = Math.round(g); tally[k] = (tally[k] || 0) + 1; }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, v]) => `${k}:${v}`).join(' ');
  const st = stat(d);
  console.log(`  ${sys.padEnd(4)}${pad(bySys[sys].length, 5)}${pad(st.med.toFixed(0) + 's', 9)}` +
              `${pad(Math.min(...d).toFixed(0) + 's', 8)}` +
              `${pad(Math.max(...d).toFixed(0) + 's', 9)}   ${top}`);
}

/* ---------- 2. 传播误差 vs 距 toe 的时间 ----------
 * 只看开普勒系。GLONASS/SBAS 是笛卡尔状态量，propagate() 对它们是线性外推
 * （X+Xd·τ+0.5·Xdd·τ²），只在 τ 很小时才成立；拿它算「误差随外推时长增长」
 * 会得到 ~900 km 这种纯属度量口径错误的数字。笛卡尔系的正确做法是数值积分，
 * 本工具不做，所以直接排除并说明。 */
const KEPSYS = SYSS.filter(x => (bySys[x][0] || {}).recs?.[0]?.kind === 'kep');
console.log(`\n=== 传播误差 vs 距最近 toe 的时间（相邻电文互推，差值即误差代理） ===`);
console.log(`  仅开普勒系 ${KEPSYS.join('/')}；笛卡尔系见上方「记录间隔」，误差口径不适用。`);
/* ⚠️ 下面这组数字**不代表轨道误差**，也不该被拿去当 σ_eph 用。 */
console.log('  ⚠ 这不是轨道误差。每条电文的钟差多项式常数项 a0 是相对**各自的 toc** 给的，');
console.log('    两条相邻电文把它各自外推到同一时刻，差的主体是钟差多项式常数项的互差，');
console.log('    不是 Kepler 参数的互差。样本上 GPS 中位 13.2 m / QZSS 135.8 m 就是这么来的。');
console.log('    尾部还混有记录边界的垃圾（GPS 最大 9.8 km、BDS 最大 1.3e7 m —— 那是跨了');
console.log('    一整天的两条电文）。当轨道误差喂进精度模型会让 σ_h 放大约 10 倍。');
console.log('    精度模型用的是各星座**广播星历的规格量级**（GPS 1.5 / BDS 2.5 / GAL 1.5 m…），');
console.log('    见 gnss_pdop_tool.html 的 EPH_SIGMA 与 README 的「误差预算」一节。');
console.log(`  ${'系'.padEnd(4)}${'Δtoe'.padStart(9)}${'n'.padStart(7)}${'中位 m'.padStart(10)}` +
            `${'p90 m'.padStart(11)}${'最大 m'.padStart(12)}`);
const decay = {};
const BIN = 300;                       // Δtoe 归到 300 s 一档，否则标签会碎成几十行
for (const sys of KEPSYS) {
  const acc = {};
  for (const s of bySys[sys]) {
    for (let i = 0; i + 1 < s.recs.length; i++) {
      const A = s.recs[i], B = s.recs[i + 1];
      const span = B.tAbs - A.tAbs;
      if (span <= 0 || span > 7500) continue;         // 只取正常相邻对，跳过重传
      for (const off of OFFSETS) {
        const t = A.tAbs + off;
        if (t > B.tAbs + 1) continue;                 // t 跑出这对电文的覆盖
        const dt = Math.min(t - A.tAbs, B.tAbs - t);
        const d = dist(C.propagate(s.sys, A, t), C.propagate(s.sys, B, t));
        const k = Math.min(Math.floor(dt / BIN) * BIN, 7200);
        (acc[k] = acc[k] || []).push(d);
      }
    }
  }
  decay[sys] = {};
  for (const k of Object.keys(acc).map(Number).sort((a, b) => a - b)) {
    const st = stat(acc[k]);
    decay[sys][k] = st;
    const lab = k + '-' + (k + BIN) + 's';
    console.log(`  ${sys.padEnd(4)}${pad(lab, 9)}${pad(st.n, 7)}${pad(st.med.toFixed(1), 10)}` +
                `${pad(st.p90.toFixed(1), 11)}${pad(st.max.toFixed(1), 12)}`);
  }
}

/* ---------- 3. 记录切换跳变 ---------- */
console.log(`\n=== 记录切换跳变（selectEph 跨过新 toe 时位置的不连续） ===`);
console.log('  selectEph 取 toe<=t 的最新记录，是阶跃函数：t 一越过 B.toe，状态就从 p_A 跳到 p_B。');
console.log(`  ${'系'.padEnd(4)}${'切换数'.padStart(8)}${'中位 m'.padStart(11)}${'p90 m'.padStart(11)}` +
            `${'最大 m'.padStart(12)}${'>100m'.padStart(9)}`);
const jump = {};
for (const sys of KEPSYS) {
  const d = [];
  for (const s of bySys[sys]) {
    for (let i = 0; i + 1 < s.recs.length; i++) {
      const A = s.recs[i], B = s.recs[i + 1];
      if (B.tAbs - A.tAbs <= 0 || B.tAbs - A.tAbs > 7500) continue;
      const tb = B.tAbs;
      d.push(dist(C.propagate(s.sys, A, tb), C.propagate(s.sys, B, tb)));
    }
  }
  if (!d.length) continue;
  const st = stat(d);
  jump[sys] = { ...st, over100pct: 100 * d.filter(x => x > 100).length / d.length };
  console.log(`  ${sys.padEnd(4)}${pad(st.n, 8)}${pad(st.med.toFixed(1), 11)}${pad(st.p90.toFixed(1), 11)}` +
              `${pad(st.max.toFixed(1), 12)}${pad(jump[sys].over100pct.toFixed(1) + '%', 9)}`);
}

/* ---------- 4. 100 ms 下卫星走了多远 ---------- */
console.log(`\n=== ${DT * 1000} ms 内卫星位移（每系统取轨道中位半径的那颗） ===`);
const motion = {};
for (const sys of KEPSYS) {
  const cands = bySys[sys].filter(s => s.recs[0].kind === 'kep');
  cands.sort((a, b) => a.recs[0].sqA - b.recs[0].sqA);
  const s = cands[cands.length >> 1];
  const r = s.recs[0], t = r.tAbs;
  const d = dist(C.propagate(sys, r, t), C.propagate(sys, r, t + DT));
  const rad = r.sqA * r.sqA;
  motion[sys] = { sat: s.key, perDt: d, speed: d / DT, phaseDeg: d / rad * 360 };
  console.log(`  ${sys.padEnd(4)}${s.key}  ${pad(d.toFixed(1), 8)} m  ` +
              `= ${pad((d / DT).toFixed(0), 6)} m/s   轨道相位 ${(d / rad * 360).toFixed(6)}°`);
}

/* ---------- 5. 100 ms 的天顶视角：仰角到底能分辨出什么 ---------- */
console.log(`\n=== ${DT * 1000} ms 内仰角变化（上海站，真实星历 + 核心的 ECEF→ENU） ===`);
{
  /* llhToEcef(latDeg, lonDeg, h) 与 enuFromEcef(dx,dy,dz,lonDeg,latDeg) 都吃**度**，
     后者返回 {rho,E,N,U} 而不是数组 —— 传弧度进去不会报错，只会静默出 NaN。 */
  const RX_LON = 121.4, RX_LAT = 31.2, RX_H = 900;
  const rx = C.llhToEcef(RX_LAT, RX_LON, RX_H);
  const elev = (sys, rec, t) => {
    const p = C.propagate(sys, rec, t);
    const v = C.enuFromEcef(p[0] - rx[0], p[1] - rx[1], p[2] - rx[2], RX_LON, RX_LAT);
    return v ? Math.asin(v.U / v.rho) / C.D2R : NaN;
  };
  // 取覆盖中点附近的一刻，全系统同一时刻才有横向可比性
  const t0 = stat(KEP.flatMap(s => s.recs.map(r => r.tAbs))).med;

  console.log(`  参考时刻 t0（全部开普勒电文 tAbs 的中位数），站点 121.4°E / 31.2°N / ${RX_H} m`);
  console.log(`  ${'PRN'.padEnd(6)}${'仰角°'.padStart(9)}${pad('Δ仰角 mdeg', 14)}` +
              `${pad('星历噪声 mdeg', 15)}${pad('信噪比', 9)}   判读`);
  const rows = [];
  for (const sys of KEPSYS) {
    for (const s of bySys[sys]) {
      const rec = C.selectEph(s, t0, C.EPH_MAX_AGE);
      if (!rec) continue;
      const e0 = elev(sys, rec, t0);
      if (!(e0 > 10 && e0 < 80)) continue;            // 只看 10–80°，避开刚升和掠顶
      const { rho } = C.enuFromEcef(...(() => {
        const p = C.propagate(sys, rec, t0);
        return [p[0] - rx[0], p[1] - rx[1], p[2] - rx[2]];
      })(), RX_LON, RX_LAT);
      rows.push({ sys, key: s.key, el: e0, de: (elev(sys, rec, t0 + DT) - e0) * 1000, rho });
      break;                                          // 每系统一颗，避免刷屏
    }
  }
  for (const r of rows.sort((a, b) => b.de - a.de)) {
    /* 判据不能拍脑袋定一个 mdeg 阈值，要跟**星历误差折算到仰角**的噪声比：
       一颗仰角 el 的星，σ 米的位置误差对仰角的贡献是 σ/rho 弧度。
       比值 >3 才算真分辨得出来（否则就是在放大噪声）。 */
    const sig = decay[r.sys] && decay[r.sys][0] ? decay[r.sys][0].med : NaN;
    const noise = sig / r.rho * C.R2D * 1000;
    const snr = Math.abs(r.de) / noise;
    const verdict = snr > 3 ? '100 ms 有分辨力' : '已在星历噪声内，再细无益';
    console.log(`  ${r.key.padEnd(6)}${pad(r.el.toFixed(2), 9)}${pad(r.de.toFixed(3), 14)}` +
                `${pad(noise.toFixed(3), 15)}${pad(snr.toFixed(1) + '×', 9)}   ${verdict}`);
  }
  console.log(`  地球自转 ${DT * 1000} ms = ${(C.OMEGA_E * DT / C.D2R * 3600).toFixed(2)} mdeg = ` +
              `${(C.OMEGA_E * DT * 6371e3).toFixed(1)} m（赤道）`);
}

/* ---------- 6. 有效窗口余量 ---------- */
console.log('\n=== EPH_MAX_AGE 余量（两星之间最坏陈旧时刻 = 间隔的一半） ===');
for (const sys of SYSS) {
  const d = gaps[sys];
  if (!d) continue;
  const med = stat(d).med;
  const worst = med / 2;
  console.log(`  ${sys.padEnd(4)}间隔中位 ${pad(med.toFixed(0) + 's', 7)} → 最坏陈旧 ` +
              `${pad(worst.toFixed(0) + 's', 7)}  窗口 ${C.EPH_MAX_AGE}s  ` +
              `${worst <= C.EPH_MAX_AGE ? 'OK' : '★超窗'}`);
}

/* ---------- 7. 步长换算 ---------- */
console.log('\n=== 步长换算 ===');
for (const dt of [1, DT]) {
  const line = `  dt=${dt}s：1 小时 ${pad(Math.round(3600 / dt), 7)} 历元   ` +
               `24 小时 ${pad(Math.round(86400 / dt), 7)} 历元`;
  console.log(dt === 1 ? line + '   ← 现有样本（5000 行 × 1 s）' : line);
}
console.log(`  selectEph 在 ${DT * 1000} ms 网格上的切换频率：`);
for (const sys of SYSS) {
  const med = gaps[sys] ? stat(gaps[sys]).med : null;
  if (!med) continue;
  console.log(`    ${sys.padEnd(4)}每 ${pad(Math.round(med / DT), 8)} 个历元切一次`);
}

/* ---------- JSON 基线 ---------- */
if (JSON_OUT) {
  const out = {
    files: FILES.map(f2 => path.basename(f2)),
    ephMaxAge: C.EPH_MAX_AGE,
    nSats: list.length,
    headers,
    gapsSec: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, stat(v)])),
    decayFromToe: decay,
    switchJump: jump,
    motionPerDt: motion,
    dtTarget: DT
  };
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`\n基线 -> ${JSON_OUT}`);
}
process.exit(0);
