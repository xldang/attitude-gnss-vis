/* PDOP / 精度因子参考实现 —— 与 pdopFromQ / accuracySolve **完全独立**的一条路径。
 *
 * 用途：给 test/e2e_browser.js 里的「Python 基准」提供数字。
 * 那些基准原本是用工具自己算出来的，等于拿自己验自己；本脚本改走
 * Schur 补：N = [[n, cᵀ],[c, B]]，位置块 = B − ccᵀ/n，直接 3×3 求逆，
 * 不经过被测代码里的 matInv4 / pdopFromQ。
 *
 * 用法：node test/tools/dop_ref.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'gnss_pdop_tool.html'), 'utf8');
(0, eval)(html.match(/<script id="gnss-core">([\s\S]*?)<\/script>/)[1]);
const C = globalThis.GNSSCore;

/* 3×3 伴随法求逆（部分主元），奇异返回 null —— 与工具里的 matInv4 无关 */
const solve3 = M => {
  const a = M.map((r, i) => r.concat([0, 1, 2].map(j => i === j ? 1 : 0)));
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    const t = a[c]; a[c] = a[p]; a[p] = t;
    const q = a[c][c];
    if (Math.abs(q) < 1e-300) return null;
    for (let k = 0; k < 6; k++) a[c][k] /= q;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = a[r][c];
      for (let k = 0; k < 6; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map(r => r.slice(3));
};

const rx = C.parseRinex(fs.readFileSync(path.join(ROOT, 'samples/rnx/BRDM00DLR_S_20262690000_01D_MN.rnx'), 'utf8'));
const tr = C.parseTraceCSV(fs.readFileSync(path.join(ROOT, 'samples/traces/flight_shanghai_xian_5000.csv'), 'utf8'));
const nEp = tr.n, nSat = rx.sats.length, satSys = rx.sats.map(s => s.sys);
const t0 = C.utcToGpsSec(rx.firstEpoch.y, rx.firstEpoch.mo, rx.firstEpoch.d,
                         rx.firstEpoch.h, rx.firstEpoch.mi, rx.firstEpoch.s, rx.header.leap);
const los = new Float32Array(nEp * nSat * 3), up = C.attUpRow(tr, nEp);
C.buildLOSChunk(rx, tr, t0, 0, nEp, los, satSys, nSat, C.EPH_MAX_AGE, null);

const of = (...sys) => rx.sats.map((s, i) => sys.includes(s.sys) ? i : -1).filter(i => i >= 0);
const all = of('G', 'C', 'E', 'I', 'J', 'R', 'S');

/* 独立路径：Schur 补。每历元累加 B=Σbbᵀ 与 c=Σb，位置块 = B − ccᵀ/n，
 * 3×3 求逆后**转到 ENU**（PDOP 是当地 ENU 水平量，不是机体系的），取
 * √(EE + NN + 2·EN)。
 * 注意 n 是**该历元的卫星数**，必须与卫星循环里的累加分开计 —— 混进同一个
 * 变量会让 n 变成卫星数的平方，PDOP 直接飞掉两个数量级。 */
function schur(idx, mask) {
  const thr = Math.sin(mask * C.D2R);
  const d = tr.data;
  let sum = 0, ok = 0;
  for (let e = 0; e < nEp; e++) {
    const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], c = [0, 0, 0];
    let n = 0;
    const u0 = up[e * 3], u1 = up[e * 3 + 1], u2 = up[e * 3 + 2];
    for (const k of idx) {
      const o = e * nSat * 3 + k * 3, z = los[o + 2];
      if (z <= thr) continue;
      const x = los[o], y = los[o + 1];
      if (u0 * x + u1 * y + u2 * z <= 0) continue;      // 地平线以下
      const v = [x, y, z];
      n++;
      for (let i = 0; i < 3; i++) { c[i] += v[i]; for (let j = 0; j < 3; j++) B[i][j] += v[i] * v[j]; }
    }
    if (n < 4) continue;                                  // 与 solveAll 一致：不可解跳过
    const P = solve3(B.map((r, i) => r.map((v, j) => v - c[i] * c[j] / n)));
    if (!P) continue;
    const K = C.dcmEnuToBody(d.Yaw[e], d.Pitch[e], d.Roll[e]);
    const Kt = [K[0], K[3], K[6], K[1], K[4], K[7], K[2], K[5], K[8]];
    const mm = (A, Bm) => {                        // 3×3 行优先乘
      const O = new Array(9);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
        O[i * 3 + j] = A[i * 3] * Bm[j] + A[i * 3 + 1] * Bm[3 + j] + A[i * 3 + 2] * Bm[6 + j];
      return O;
    };
    const R = mm(mm(Kt, P.flat()), K);      // solve3 返回嵌套 3×3，展平后才能喂 mm
    sum += Math.sqrt(R[0] + R[4] + 2 * R[3]);
    ok++;
  }
  return sum / ok;
}

const masks = [0, 5, 10, 15, 20, 30, 45];
const ref = masks.map(m => {
  const thr = Math.sin(m * C.D2R);
  let n = 0;
  for (let e = 0; e < nEp; e++) {
    const u0 = up[e * 3], u1 = up[e * 3 + 1], u2 = up[e * 3 + 2];
    for (const k of all) {
      const o = e * nSat * 3 + k * 3, z = los[o + 2];
      if (z <= thr) continue;
      if (u0 * los[o] + u1 * los[o + 1] + u2 * z <= 0) continue;
      n++;
    }
  }
  return [m, n / nEp, schur(all, m)];
});

console.log('独立 Schur 补路径 —— test/e2e_browser.js 的基准来源');
console.log('  轨迹 ' + path.basename('flight_shanghai_xian_5000.csv') + ' · ' + nEp + ' 历元 · 全部 7 系统\n');
console.log('  掩角   平均星数   平均 PDOP');
for (const [m, c, p] of ref) console.log('  ' + String(m).padStart(3) + '°   ' + c.toFixed(3).padStart(7) + '    ' + p.toFixed(4));
console.log('\n  星座组合（掩角 15°）   平均 PDOP');
console.log('    仅 GPS    ' + schur(of('G'), 15).toFixed(4));
console.log('    仅 BDS    ' + schur(of('C'), 15).toFixed(4));
console.log('    GPS+BDS   ' + schur(of('G', 'C'), 15).toFixed(4));
console.log('    GCE      ' + schur(of('G', 'C', 'E'), 15).toFixed(4));
console.log('\n把这几个数字贴进 test/e2e_browser.js 的 scanExp / 分星座基准，');
console.log('并在改动 pdopFromQ 之后重新生成本表 —— 不要拿工具自己的输出来填。');
