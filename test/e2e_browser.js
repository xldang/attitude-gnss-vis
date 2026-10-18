/* 端到端浏览器验收：用 CDP 驱动真实 Chrome，走 file:// 双击等价的路径，
 * 载入两个样本文件 -> 运行仿真 -> 拖掩角滑块 -> 只勾 GPS / 只勾北斗 -> 自检 -> 导出 CSV。
 * Node 核心回归（test_core.js）不覆盖 UI 接线与 Blob 下载，这条补上。
 *
 *   node test/e2e_browser.js
 *
 * 需要本机装有 Chrome。所有路径相对本文件解析，测试产物写进 build/。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HTML = 'file:///' + path.join(ROOT, 'gnss_pdop_tool.html').replace(/\\/g, '/');
const RNX = path.join(ROOT, 'samples', 'rnx', 'BRDM00DLR_S_20262690000_01D_MN.rnx');
const CSV = path.join(ROOT, 'samples', 'traces', 'flight_shanghai_xian_5000.csv');
const DL = path.join(BUILD, 'e2e_download');
const PORT = 9333;

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });

let fails = 0;
const chk = (name, ok, detail) => {
  if (!ok) fails++;
  console.log('  [' + (ok ? '通过' : '失败') + '] ' + name + (detail ? '   ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--allow-file-access-from-files', '--window-size=1600,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find(t => t.type === 'page');
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) { console.error('Chrome 未就绪'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const errs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown')
      errs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errs.push('console.error: ' + m.params.args.map(a => a.value).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      errs.push('log: ' + m.params.entry.text);
  };
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
    return r.result.result.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  /* rAF 在无头模式下可能被节流，分块计算靠它推进，先确认它确实在走 */
  const rafAlive = async () => evalJS(
    'new Promise(r=>{const t=setTimeout(()=>r(false),3000);requestAnimationFrame(()=>{clearTimeout(t);r(true)})})');

  console.log('=== 页面载入 ===');
  await send('Page.navigate', { url: HTML });
  await sleep(1500);
  chk('页面加载无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
  chk('核心与调试句柄已导出',
      await evalJS('typeof GNSSCore === "object" && typeof GNSS_VIEW === "object"'));
  chk('requestAnimationFrame 在无头模式下正常触发', await rafAlive());
  chk('掩角滑块默认 15°', (await evalJS('document.getElementById("mask").value')) === '15');
  chk('滑块范围 0–45 步进 0.5',
      await evalJS('(()=>{const m=document.getElementById("mask");' +
                   'return m.min==="0"&&m.max==="45"&&m.step==="0.5"})()'));

  console.log('\n=== 导入样本文件 ===');
  const doc = await send('DOM.getDocument', { depth: -1 });
  for (const [sel, file] of [['#fRnx', RNX], ['#fCsv', CSV]]) {
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: sel });
    await send('DOM.setFileInputFiles', { files: [file], nodeId: q.result.nodeId });
    await sleep(500);
  }
  chk('起始 UTC 自动填为星历首条历元',
      (await evalJS('document.getElementById("t0").value')) === '2026-09-26T00:00',
      await evalJS('document.getElementById("t0").value'));
  chk('运行按钮已启用', !(await evalJS('document.getElementById("bRun").disabled')));

  await evalJS('document.getElementById("bRun").click()');
  let done = false;
  for (let i = 0; i < 240 && !done; i++) { await sleep(250); done = !(await evalJS('document.getElementById("bExp").disabled')); }
  chk('仿真完成（导出按钮解锁）', done,
      done ? '' : '日志: ' + await evalJS('document.getElementById("log").textContent.trim().split("\\n").slice(-2).join(" / ")'));
  chk('全程无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));
  chk('导出按钮已启用', !(await evalJS('document.getElementById("bExp").disabled')));
  chk('星座开关列出 7 个系统且默认全开',
      await evalJS('(()=>{const i=[...document.querySelectorAll("#syslist input")];' +
                   'return i.length===7 && i.every(x=>x.checked)})()'),
      await evalJS('[...document.querySelectorAll("#syslist input")].map(x=>x.dataset.sys).join("")'));

  const AVGE = 'GNSS_VIEW.state';
  const stats = `(()=>{const c=${AVGE}.counts, p=${AVGE}.pdops.filter(Number.isFinite);` +
    `return {n:${AVGE}.trace.n, np:p.length,` +
    `avg:+(c.reduce((a,b)=>a+b,0)/c.length).toFixed(3),` +
    `pavg:+(p.reduce((a,b)=>a+b,0)/p.length).toFixed(4)}})()`;
  const st = await evalJS(stats);
  console.log('  页面状态: 历元 ' + st.n + '，有效 PDOP ' + st.np +
              '，平均星数 ' + st.avg + '，平均 PDOP ' + st.pavg);
  chk('平均星数 = Python 基准 53.413', Math.abs(st.avg - 53.413) < 0.05, '' + st.avg);
  chk('平均 PDOP = Python 基准 0.6224', Math.abs(st.pavg - 0.6224) < 0.002, '' + st.pavg);

  console.log('\n=== 掩角滑块实时响应 ===');
  const sweep = await evalJS(`(async () => {
    const m = document.getElementById('mask'), out = [];
    for (const v of [0,5,10,15,20,30,45]) {
      const t0 = performance.now();
      m.value = v; m.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = ${AVGE}.counts.reduce((a,b)=>a+b,0)/${AVGE}.counts.length;
      const p = ${AVGE}.pdops.filter(Number.isFinite);
      out.push([v, +c.toFixed(3), +(p.reduce((a,b)=>a+b,0)/p.length).toFixed(4),
                +(performance.now()-t0).toFixed(1)]);
    }
    return out;
  })()`);
  sweep.forEach(s => console.log('    mask ' + String(s[0]).padStart(2) + '°  平均星数 ' +
    s[1].toFixed(2) + '  平均 PDOP ' + s[2].toFixed(4) + '  重算 ' + s[3].toFixed(1) + ' ms'));
  chk('7 档全部重算 < 200 ms（拖动秒级响应）', sweep.every(s => s[3] < 200),
      sweep.map(s => s[3].toFixed(0)).join('/') + ' ms');
  const scanExp = [[0, 66.640, 0.4251], [5, 62.916, 0.4648], [10, 57.845, 0.5363],
                   [15, 53.413, 0.6224], [20, 48.602, 0.7610], [30, 39.222, 1.1709],
                   [45, 23.151, 2.6840]];
  const bad = sweep.filter((s, i) =>
    Math.abs(s[1] - scanExp[i][1]) > 0.05 || Math.abs(s[2] - scanExp[i][2]) > 0.002);
  chk('7 档掩角的星数/PDOP 全与 Python 基准一致', bad.length === 0,
      bad.length ? JSON.stringify(bad) : sweep.map(s => s[1] + '星/' + s[2]).join(' '));

  console.log('\n=== 分星座独立仿真（掩角回到 15°）===');
  await evalJS(`(()=>{const m=document.getElementById('mask');m.value=15;
      m.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await sleep(250);
  const pick = async sel => {
    await evalJS('GNSS_VIEW.setSystems(' + JSON.stringify(sel) + ')');
    await sleep(200);
    return evalJS(stats);
  };
  const gps = await pick(['G']), bds = await pick(['C']), gb = await pick(['G', 'C']);
  const cmp = (nm, r, en, ep) => chk(nm, Math.abs(r.avg - en) < 0.05 && Math.abs(r.pavg - ep) < 0.002,
    '平均星数 ' + r.avg + '，平均 PDOP ' + r.pavg + '（基准 ' + en + ' / ' + ep + '）');
  cmp('仅 GPS 独立仿真', gps, 7.347, 1.8805);
  cmp('仅北斗独立仿真', bds, 16.564, 1.2263);
  cmp('GPS + 北斗', gb, 23.911, 0.9594);
  chk('星座切换期间无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n=== 页面内自检面板 ===');
  await pick(['G', 'R', 'E', 'C', 'J', 'S', 'I']);
  await evalJS('document.getElementById("bSelf").click()');
  await sleep(800);
  const failed = await evalJS(`(()=>[...document.querySelectorAll('#tests span.r')]
      .map(s => s.closest('tr').children[1].textContent))()`);
  const total = await evalJS(`document.querySelectorAll('#tests tr').length`);
  chk('页面自检全部通过（' + total + ' 项）', failed.length === 0,
      failed.length ? '失败: ' + failed.join('; ')
        : await evalJS('(()=>{const L=document.getElementById("log").textContent.trim().split("\\n");' +
                       'return L.find(x=>x.includes("自检"))||L[L.length-1]})()'));

  console.log('\n=== 联动图表 ===');
  // 视窗回归：曾经 CH.xb 从未在载入数据时初始化，一直停在字面量 1，
  // 于是两张图只画了历元 0~1（x 轴标注 0:00~0:01、y 值域只有 2 个点）却不报错。
  const win = await evalJS('({xa:GNSS_VIEW.view.xa, xb:GNSS_VIEW.view.xb, n:GNSS_VIEW.state.trace.n})');
  chk('x 视窗覆盖全部 5000 历元', win.xa === 0 && win.xb === win.n - 1,
      '[' + win.xa + ', ' + win.xb + ']，n=' + win.n);

  // 曲线墨迹必须横向铺满绘图区（而不是挤在左边缘的一小段）。
  // 判据用"主色显著占优"而不是精确 RGB：1.4 px 描边是抗锯齿的，逐像素几乎不会是纯色。
  const ink = await evalJS(`(()=>{const o={};
    for (const id of ['c1','c2']) {
      const c=document.getElementById(id), g=c.getContext('2d');
      const d=g.getImageData(0,0,c.width,c.height).data;
      const t = id==='c1' ? (i => (d[i+2]-d[i])>40 && d[i+2]>120)
                          : (i => (d[i]-d[i+1])>60 && d[i]>150);
      const hit=new Set();
      for(let y=0;y<c.height;y++) for(let x=0;x<c.width;x++) if(t((y*c.width+x)*4)) hit.add(x);
      const xs=[...hit];
      o[id]=[xs.length, Math.min(...xs), Math.max(...xs), c.width];
    } return o})()`);
  chk('图一曲线横向铺满绘图区', ink.c1[0] > 700 && ink.c1[1] <= 60 && ink.c1[2] >= 940,
      `着墨列 ${ink.c1[0]}，x 跨度 ${ink.c1[1]}~${ink.c1[2]}（绘图区 58~946）`);
  chk('图二曲线横向铺满绘图区', ink.c2[0] > 700 && ink.c2[1] <= 60 && ink.c2[2] >= 940,
      `着墨列 ${ink.c2[0]}，x 跨度 ${ink.c2[1]}~${ink.c2[2]}（绘图区 58~946）`);

  const same = await evalJS(`(()=>{const g=id=>document.getElementById(id).getContext('2d')
      .getImageData(0,0,document.getElementById(id).width,document.getElementById(id).height).data;
      const a=g('c1'), b=g('c2'); if(a.length!==b.length) return true;
      let d=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) d++; return d===0})()`);
  chk('两张图内容不同（星数图 vs PDOP 图）', !same);

  // 滚轮缩放 + 双击复位
  // 缩放语义必须钉死：一次滚轮 = 宽度乘一个固定因子，光标处锚点不动，
  // 连乘要能累乘，越界时平移窗口而不是截断（截断会悄悄改宽度，正是"越滚越乱"的来源）。
  const WHEEL_X = 700;
  const rect = await evalJS(`(()=>{const r=document.getElementById('c1').getBoundingClientRect();
      return {left:r.left,width:r.width}})()`);
  const FR = Math.max(0, Math.min(1, (WHEEL_X - rect.left - 58) / Math.max(1, rect.width - 58 - 16)));
  const win_ = () => evalJS('({xa:GNSS_VIEW.view.xa, xb:GNSS_VIEW.view.xb})');
  const wheel = async dy => {
    await evalJS(`(()=>{const c=document.getElementById('c1');
        c.dispatchEvent(new WheelEvent('wheel',{deltaY:${dy},deltaMode:0,clientX:${WHEEL_X},clientY:200,
          bubbles:true,cancelable:true}))})()`);
    await sleep(160);
    return win_();
  };
  const K = Math.pow(1.22, -4);                 // deltaY=-600 被夹到 -4
  const z0 = await win_();
  const z1 = await wheel(-600);
  const z2 = await wheel(-600);
  const s0 = z0.xb - z0.xa, s1 = z1.xb - z1.xa, s2 = z2.xb - z2.xa;
  chk('滚轮缩放：一次滚轮宽度按固定因子收窄', Math.abs(s1 / s0 - K) < 0.01,
      `宽度 ${s0.toFixed(0)} -> ${s1.toFixed(0)}（比值 ${(s1 / s0).toFixed(4)}，期望 ${K.toFixed(4)}）`);
  chk('滚轮缩放：连续滚轮能累乘（不取陈旧几何）', Math.abs(s2 / s1 - K) < 0.01,
      `宽度 ${s1.toFixed(0)} -> ${s2.toFixed(0)}（比值 ${(s2 / s1).toFixed(4)}）`);
  const a1 = z1.xa + FR * s1, a2 = z2.xa + FR * s2;
  chk('滚轮缩放：光标处锚点保持不动', Math.abs(a1 - a2) < 2,
      `锚点历元 ${a1.toFixed(1)} -> ${a2.toFixed(1)}（光标位于绘图区 ${(FR * 100).toFixed(0)}% 处）`);
  chk('滚轮缩放：视窗不越界且宽度未被截断改变',
      z2.xa >= 0 && z2.xb <= win.n - 1 && Math.abs(s2 - (z2.xb - z2.xa)) < 1e-9,
      `视窗 [${z2.xa.toFixed(0)}, ${z2.xb.toFixed(0)}]，数据范围 [0, ${win.n - 1}]`);
  for (let i = 0; i < 8; i++) await wheel(+600);          // 一路放大回全景
  const z3 = await win_();
  chk('滚轮放大到头正好回到全景', z3.xa === 0 && z3.xb === win.n - 1,
      `[${z3.xa}, ${z3.xb}]，宽度 ${(z3.xb - z3.xa).toFixed(0)}`);
  // 拖拽平移：只能平移，宽度必须纹丝不动；顶到数据边缘也不许被截断改宽
  await evalJS(`(()=>{GNSS_VIEW.view.xa=2000;GNSS_VIEW.view.xb=3000;GNSS_VIEW.drawAll()})()`);
  const panTo = async dx => {
    await evalJS(`(()=>{const c=document.getElementById('c1');
        c.dispatchEvent(new MouseEvent('mousedown',{clientX:500,clientY:200,bubbles:true}));
        c.dispatchEvent(new MouseEvent('mousemove',{clientX:${500 + dx},clientY:200,bubbles:true}))})()`);
    await sleep(160);
    const v = await win_();
    await evalJS(`window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))`);
    return v;
  };
  const p1 = await panTo(200);
  chk('拖拽平移只改位置不改宽度', Math.abs((p1.xb - p1.xa) - 1000) < 1 && p1.xa < 2000,
      `[2000, 3000] 右拖 200 px -> [${p1.xa.toFixed(0)}, ${p1.xb.toFixed(0)}]，宽度 ${(p1.xb - p1.xa).toFixed(0)}（内容跟手，窗口左移）`);
  await evalJS(`(()=>{GNSS_VIEW.view.xa=0;GNSS_VIEW.view.xb=1000;GNSS_VIEW.drawAll()})()`);
  const p2 = await panTo(400);            // 往左猛拖，越过数据左边界
  chk('拖拽顶到数据边缘只平移不被截断', p2.xa === 0 && Math.abs((p2.xb - p2.xa) - 1000) < 1,
      `[0, 1000] 往左拖 400 px -> [${p2.xa.toFixed(0)}, ${p2.xb.toFixed(0)}]，宽度 ${(p2.xb - p2.xa).toFixed(0)}`);
  // 缩到不能再缩：应停在最小视窗而不是塌成一条线/出现负区间
  for (let i = 0; i < 14; i++) await wheel(-600);
  const z4 = await win_();
  chk('滚轮缩小到头停在最小视窗（不塌成一条线）',
      z4.xb - z4.xa >= 10 - 1e-6 && z4.xa >= 0 && z4.xb <= win.n - 1,
      `[${z4.xa.toFixed(1)}, ${z4.xb.toFixed(1)}]，宽度 ${(z4.xb - z4.xa).toFixed(1)} 历元（最小 10）`);
  // 视窗极窄时仍要能正常出图（轴标签、曲线都在）
  const narrowInk = await evalJS(`(()=>{GNSS_VIEW.drawAll();
      const c=document.getElementById('c1'), d=c.getContext('2d')
        .getImageData(0,0,c.width,c.height).data, hit=[];
      for(let x=0;x<c.width;x++){for(let y=0;y<c.height;y+=2){const i=(y*c.width+x)*4;
        if(d[i+2]-d[i]>40&&d[i+2]>120){hit.push(x);break}}} return [hit.length,Math.min(...hit),Math.max(...hit)]})()`);
  chk('最小视窗下曲线仍铺满绘图区', narrowInk[0] > 700 && narrowInk[1] <= 60 && narrowInk[2] >= 940,
      `着墨列 ${narrowInk[0]}，x 跨度 ${narrowInk[1]}~${narrowInk[2]}`);

  await evalJS(`(()=>{const c=document.getElementById('c1');
      c.dispatchEvent(new MouseEvent('dblclick',{clientX:700,clientY:200,bubbles:true}))})()`);
  await sleep(250);
  const reset = await evalJS('({xa:GNSS_VIEW.view.xa, xb:GNSS_VIEW.view.xb})');
  chk('双击复位回全景', reset.xa === 0 && reset.xb === win.n - 1,
      '[' + reset.xa + ', ' + reset.xb + ']');
  const before = await evalJS('GNSS_VIEW.state.counts[100]');
  await evalJS(`(()=>{const m=document.getElementById('mask');m.value=30;
      m.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await sleep(300);
  const after = await evalJS('GNSS_VIEW.state.counts[100]');
  chk('拖动滑块后曲线数据随之变化', after !== before, '历元 100 星数 ' + before + ' -> ' + after);
  await evalJS(`(()=>{const m=document.getElementById('mask');m.value=15;
      m.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await sleep(300);

  // 悬停回归：曾经每个 mousemove 都同步重画两张 5000 点图，光标一进图表区
  // 首批事件要 14/32/82/153/294 ms，主线程被卡住，界面看起来像崩了。
  const hb = await evalJS(`(()=>{const r=document.getElementById('c1').getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  await evalJS(`window.__drag=0;(function b(){const e=performance.now();
    requestAnimationFrame(()=>{window.__drag=Math.max(window.__drag,performance.now()-e-16.7);b()})})()`);
  for (let k = 0; k <= 40; k++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: hb.x + 60 + (hb.w - 80) * (k % 20) / 20, y: hb.y + hb.h / 2, buttons: 0 });
    await sleep(8);
  }
  const drift = await evalJS('window.__drag');
  chk('悬停不产生长任务（rAF 漂移 < 100 ms）', drift < 100,
      '40 次鼠标移动，最大帧漂移 ' + drift.toFixed(1) + ' ms（修复前光标移入即出现 294 ms 长任务）');

  // 画布高度指数膨胀回归：setup() 若从 height 属性读逻辑高度再写回 canvas.height，
  // 每次绘制都会翻倍（230 -> 460 -> 920 -> ...），元素被撑到几十万像素高，
  // 悬停时表现为图表崩溃式闪烁。必须断言属性/后备存储/CSS 高度三者都不再增长。
  await evalJS(`(()=>{window.__wset=0;const d=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');
    Object.defineProperty(HTMLCanvasElement.prototype,'width',{get(){return d.get.call(this)},
      set(v){window.__wset++;d.set.call(this,v)}});return 1})()`);
  for (let k = 0; k <= 80; k++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: hb.x + 60 + (hb.w - 80) * (k % 40) / 40, y: hb.y + hb.h / 2, buttons: 0 });
    await sleep(8);
  }
  await sleep(300);
  const cv = await evalJS(`(()=>{const dpr=window.devicePixelRatio||1,c=document.getElementById('c1');
    return {attr:+c.getAttribute('height'), backing:c.height, cssH:c.style.height,
            want:Math.round(230*dpr), wantCss:'230px', wset:window.__wset,
            rectH:Math.round(c.getBoundingClientRect().height)}})()`);
  chk('画布逻辑高度不随重绘增长（属性/后备存储/CSS 三者一致）',
      cv.attr === 230 && cv.cssH === cv.wantCss && cv.backing === cv.want && cv.rectH === 230,
      'height 属性=' + cv.attr + '，CSS 高度=' + cv.cssH + '，后备存储高=' + cv.backing +
      '（期望 ' + cv.want + '），元素高=' + cv.rectH + '（期望 230）');
  chk('悬停期间不重建画布后备存储', cv.wset === 0,
      '80 次悬停重绘，canvas.width 赋值 ' + cv.wset + ' 次（修复前每次重绘都翻倍重分配）');

  console.log('\n=== ② 图② 姿态叠加 ===');
  // 叠加只重绘、不重解：不改变任何数值结果，勾选前后 counts/pdops 必须逐历元相同。
  const ovlBase = await evalJS(`(()=>{const s=GNSS_VIEW.state;let h=0;
      for(let i=0;i<s.trace.n;i++) h=(h*31+s.counts[i])>>>0;
      return {h, c0:s.counts[0], c2498:s.counts[2498]}})()`);

  // 抓 c1 上一帧画了什么：文字、线色、线型
  const ovlProbe = `(()=>{
      const V=GNSS_VIEW, P=CanvasRenderingContext2D.prototype;
      const of=P.fillText, ost=P.stroke, osd=P.setLineDash;
      const seen={txt:[],stroke:[],dash:[]};
      P.fillText=function(t,x,y){ if(this.canvas&&this.canvas.id==='c1') seen.txt.push({t:String(t),x:x,y:y}); return of.apply(this,arguments); };
      P.stroke=function(){ if(this.canvas&&this.canvas.id==='c1') seen.stroke.push(this.strokeStyle); return ost.apply(this,arguments); };
      P.setLineDash=function(d){ if(this.canvas&&this.canvas.id==='c1'&&d&&d.length) seen.dash.push(d.join(',')); return osd.apply(this,arguments); };
      V.drawAll();
      P.fillText=of; P.stroke=ost; P.setLineDash=osd;
      const PR=document.getElementById('c1').getBoundingClientRect().width-16-40;
      return {txt:seen.txt.map(e=>e.t), stroke:seen.stroke, dash:seen.dash, note:document.getElementById('ovNote').textContent};
  })()`;

  const off = await evalJS(ovlProbe);
  chk('未勾选时不画右侧角度副轴',
      !off.txt.some(t => t === '°'),
      'c1 上出现 "°" 单位标记：' + off.txt.filter(t => t === '°').length + ' 处');
  chk('未勾选时三色曲线一条都不画',
      !off.stroke.some(c => ['#0d9488', '#9333ea', '#db2777'].includes(c)),
      'c1 用到的线色：' + Array.from(new Set(off.stroke)).join(' '));
  chk('未勾选时 #ovNote 为空', off.note === '', '实际 "' + off.note + '"');

  // 逐条勾，检查"按需出现"而不是"画一次就留着"
  await evalJS(`GNSS_VIEW.setOvl('Roll')`);
  await sleep(120);
  const r1 = await evalJS(ovlProbe);
  chk('勾选 Roll 后右轴与 Roll 曲线都出现',
      r1.txt.includes('°') && r1.stroke.includes('#db2777') && r1.txt.filter(t => t === '°').length === 1,
      '右轴单位标记 ' + r1.txt.filter(t => t === '°').length + ' 处，Roll 色(#db2777) 描边 ' +
      r1.stroke.filter(c => c === '#db2777').length + ' 次');

  await evalJS(`GNSS_VIEW.setOvl('Yaw');GNSS_VIEW.setOvl('Pitch')`);
  await sleep(120);
  const r3 = await evalJS(ovlProbe);
  const COL = { Yaw: '#0d9488', Pitch: '#9333ea', Roll: '#db2777' };
  const DASH = { Yaw: '', Pitch: '5,3', Roll: '7,3,2,3' };
  const missC = Object.keys(COL).filter(k => !r3.stroke.includes(COL[k]));
  const missD = Object.keys(DASH).filter(k => DASH[k] && !r3.dash.includes(DASH[k]));
  const COLS = Object.keys(COL).map(k => COL[k]);
  chk('三条姿态曲线全部描边，且线型各不相同（不只靠颜色区分）',
      missC.length === 0 && missD.length === 0 && r3.txt.filter(t => t === '°').length === 1,
      '缺色 ' + (missC.join(',') || '无') + '，缺线型 ' + (missD.join(',') || '无') +
      '；实到姿态色 ' + r3.stroke.filter(c => COLS.includes(c)).length + ' 次描边');

  // 右轴量程 == 当前视窗内已勾选列的并集（外扩 6% 后取整）
  const rng = await evalJS(`(()=>{const V=GNSS_VIEW,s=V.state;
      const i0=Math.max(0,Math.floor(V.view.xa)),i1=Math.min(s.trace.n-1,Math.ceil(V.view.xb));
      const rs=V.ovlRange(['Yaw','Pitch','Roll'],i0,i1);
      let lo=Infinity,hi=-Infinity; for(const [a,b] of rs){lo=Math.min(lo,a);hi=Math.max(hi,b);}
      const p=(hi-lo)*0.06;
      return {want:Math.floor(lo-p)+'…'+Math.ceil(hi+p)+'°', got:lo.toFixed(2)+'…'+hi.toFixed(2),
              note:document.getElementById('ovNote').textContent}})()`);
  chk('右轴量程 = 已勾选曲线在当前视窗内的并集（共享轴，不是各自归一化）',
      rng.note.indexOf('右轴 ' + rng.want) === 0,
      '并集 ' + rng.got + ' -> 轴 ' + rng.want + '；#ovNote = ' + rng.note.slice(0, 46));

  // 星数阶梯线不能被顶到右轴外侧：右轴占掉 40 px 后绘图区右界必须是 geomCache.PR
  const ovg = await evalJS(`(()=>{const c=document.getElementById('c1');
      const r=c.getBoundingClientRect(), g=GNSS_VIEW.geom()[0];
      return {PR:g.PR, cssW:r.width, wantPR:Math.round(r.width-16-40)}})()`);
  chk('叠加后绘图区右界左移，副轴不与数据重叠',
      ovg.PR === ovg.wantPR && ovg.PR < ovg.cssW - 16,
      'geomCache.PR=' + ovg.PR + '，期望 ' + ovg.wantPR + '，画布宽 ' + ovg.cssW);

  // 悬停映射：同一 clientX 在"无叠加 / 有叠加"下必须解析到同一历元。
  // 直接改内部变量不算数，用真实 mouse 事件 + 读回 CH.hover。
  const hov = await evalJS(`(()=>{const c=document.getElementById('c1');
      const r=c.getBoundingClientRect(), g=GNSS_VIEW.geom()[0];
      return {left:r.left, top:r.top, h:r.height,
              x:r.left+g.PL+(g.PR-g.PL)*0.5, y:r.top+120}})()`);
  const sendHover = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hov.x, y: hov.y, buttons: 0 });
    await sleep(120);
    return evalJS('({hover:GNSS_VIEW.view.hover, sky:GNSS_VIEW.sky.ep, s1:document.getElementById("s1").textContent})');
  };
  const hOn = await sendHover();
  const wantEp = await evalJS(`(()=>{const g=GNSS_VIEW.geom()[0];
      return Math.round(g.i0+0.5*(g.i1-g.i0))})()`);
  chk('勾选叠加后光标仍落在同一历元（idxFromX 走 geomCache.PR，不是写死的内边距）',
      hOn.hover === wantEp && hOn.sky === wantEp,
      '光标在绘图区正中 -> 历元 ' + hOn.hover + '（期望 ' + wantEp + '），星空图 ' + hOn.sky);
  const s1ok = await evalJS(`(()=>{const i=GNSS_VIEW.view.hover, d=GNSS_VIEW.state.trace.data;
      const want=['Yaw','Pitch','Roll'].map(k=>k+' '+d[k][i].toFixed(1)+'°');
      const got=document.getElementById('s1').textContent;
      return {want, miss:want.filter(w=>got.indexOf(w)<0)}})()`);
  chk('状态行同步显示该历元的三个姿态角（与 CSV 原值一致）',
      s1ok.miss.length === 0 && hOn.s1.indexOf('颗') >= 0,
      '#s1 = ' + hOn.s1 + (s1ok.miss.length ? '；缺 ' + s1ok.miss.join(' ') : ''));

  // 拖拽分母：勾选叠加后右侧让出 40 px，若分母仍写死 clientWidth-PAD.l-PAD.r，
  // 拖拽会比指针慢约 4%，表现为"拖不动/跟不上"，极难目测发现。
  // 必须先缩放到一个**有富余**的窗口：全景 [0, n-1] 已经顶到两端，
  // 拖拽本来就被 `if (na < 0) { nb -= na; na = 0 }` 夹住不动，测不出分母。
  await evalJS(`GNSS_VIEW.view.xa=2000;GNSS_VIEW.view.xb=3000;GNSS_VIEW.drawAll()`);
  await sleep(120);
  const dr = await evalJS(`(()=>{const c=document.getElementById('c1');
      const r=c.getBoundingClientRect(), g=GNSS_VIEW.geom()[0];
      return {x:r.left+r.width/2, y:r.top+r.height/2, span:g.i1-g.i0, plotW:g.PR-g.PL,
              xa0:GNSS_VIEW.view.xa}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dr.x, y: dr.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dr.x - 100, y: dr.y, buttons: 1 });
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dr.x - 100, y: dr.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  // 位移要看 **xa 的变化量**，不是 i1-i0（那是窗口宽度，拖拽本来就不该改变它）
  const dres = await evalJS(`(()=>{const V=GNSS_VIEW;
      return {xa1:V.view.xa, moved:V.view.xa-(${dr.xa0}),
              width:V.view.xb-V.view.xa, span:${dr.span}}})()`);
  // 把"视窗平移量"换算回**像素**：拖了 100 px 就应该正好换回 100 px 的绘图区宽度。
  // 这个形式才与量程无关——之前用 |Δ历元|/跨度 归一化，分母写死时误差只有 4.4/1000 = 0.44%，
  // 被 0.5% 的容差放过去了（相对"期望位移"的 4.2% 才是大数，用跨度归一化反而把它稀释掉了）。
  const pxMoved = dres.moved * dr.plotW / dres.span;
  const pxWrong = 100 * dr.plotW / (dr.plotW + 40);
  chk('拖拽平移速度与绘图区宽度一致（分母取 geomCache 的 PR−PL）',
      Math.abs(pxMoved - 100) < 1 && Math.abs(dres.width - dres.span) < 1,
      '左移 100 px -> 等效 ' + pxMoved.toFixed(2) + ' px（期望 100）；视窗平移 ' +
      dres.moved.toFixed(1) + ' 历元' +
      '（分母 ' + dr.plotW.toFixed(0) + ' px；若写死 clientWidth−PAD.l−PAD.r 则等效 ' +
      pxWrong.toFixed(1) + ' px）；窗口宽度 ' + dres.width.toFixed(0) +
      '（期望 ' + dres.span + '，拖拽不该改宽度）');

  // 叠加不改变任何数值结果
  const ovlBase2 = await evalJS(`(()=>{const s=GNSS_VIEW.state;let h=0;
      for(let i=0;i<s.trace.n;i++) h=(h*31+s.counts[i])>>>0;
      return {h, c0:s.counts[0], c2498:s.counts[2498]}})()`);
  chk('勾选姿态曲线不改变任何数值结果（只重绘、不重解）',
      ovlBase2.h === ovlBase.h && ovlBase2.c0 === ovlBase.c0 && ovlBase2.c2498 === ovlBase.c2498,
      '历元 0 星数 ' + ovlBase2.c0 + '，历元 2498 星数 ' + ovlBase2.c2498);

  // 性能：drawAll() 里的大头是两张星空图的贪心标号，不是叠加曲线。
  // 所以要断言的是**相对开销**（叠加只多一趟 O(n) 的 min/max 扫描），
  // 钉一个绝对毫秒数会把星空图的波动算到叠加头上。
  const perfOff = await evalJS(`(()=>{GNSS_VIEW.ovlSet([]);
      const V=GNSS_VIEW, ts=[];
      for(let k=0;k<25;k++){const t0=performance.now(); V.drawAll(); ts.push(performance.now()-t0);}
      ts.sort((a,b)=>a-b); return ts[12]})()`);
  const perfOn = await evalJS(`(()=>{const V=GNSS_VIEW, ts=[];
      for(let k=0;k<25;k++){const t0=performance.now(); V.drawAll(); ts.push(performance.now()-t0);}
      ts.sort((a,b)=>a-b); return ts[12]})()`);
  chk('叠加三条曲线不显著拖慢重绘（中位开销 < 基线 1.5 倍 + 0.5 ms）',
      perfOn < perfOff * 1.5 + 0.5 && perfOn < 8,
      '未叠加 ' + perfOff.toFixed(2) + ' ms -> 叠加三条 ' + perfOn.toFixed(2) +
      ' ms（差 ' + (perfOn - perfOff).toFixed(2) + ' ms）');

  // 收工：全部取消勾选，后续星空图断言不受右轴影响
  await evalJS('GNSS_VIEW.ovlSet([])');
  await evalJS(`GNSS_VIEW.view.xa=0;GNSS_VIEW.view.xb=GNSS_VIEW.state.trace.n-1;GNSS_VIEW.view.hover=-1;GNSS_VIEW.drawAll()`);
  await sleep(150);
  const offAgain = await evalJS(ovlProbe);
  chk('取消勾选后右轴与曲线一起消失（不是画过一次就留着）',
      !offAgain.txt.includes('°') && !offAgain.stroke.some(c => ['#0d9488', '#9333ea', '#db2777'].includes(c)) &&
      offAgain.note === '',
      '残留单位标记 ' + offAgain.txt.filter(t => t === '°').length + ' 处，' +
      '残留姿态色 ' + offAgain.stroke.filter(c => ['#0d9488', '#9333ea', '#db2777'].includes(c)).length + ' 次');

  console.log('\n=== ① 卫星星空图 ===');
  // 星空图必须与图 ②/③ 的光标严格同步，且集合 = 星座开关 ∩ (z_b > sin 掩角)。
  // 用真实 mousemove 事件驱动联动，而不是直接改内部变量。
  await evalJS(`(()=>{const c=document.getElementById('c1');
      const r=c.getBoundingClientRect(), x=r.left+58+(r.width-74)*0.5;
      c.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:r.top+120,bubbles:true}));
      return 1})()`);
  await sleep(200);
  const sky = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, ep=V.view.hover;
      const d=document.getElementById('c3').getContext('2d')
        .getImageData(0,0,document.getElementById('c3').width,document.getElementById('c3').height).data;
      let ink=0; for(let i=0;i<d.length;i+=4) if(d[i+3]>10&&(d[i]+d[i+1]+d[i+2])<720) ink++;
      return {ep, count:s.counts[ep], st:document.getElementById('s3').textContent,
              list:document.getElementById('prn').textContent, ink:ink,
              attr:+document.getElementById('c3').getAttribute('height'),
              backing:document.getElementById('c3').height}})()`);
  chk('星空图随光标联动到对应历元', sky.ep > 2000 && sky.ep < 3000,
      '光标落在 50% 处 -> 历元 ' + sky.ep + '，状态行「' + sky.st + '」');
  chk('星空图可视星数与图 ② 曲线一致', sky.list && sky.count > 0 &&
      new RegExp('可视 ' + sky.count + ' 颗').test(sky.st),
      '图② ' + sky.count + ' 颗，状态行「' + sky.st + '」');
  // 编号列表必须逐个列出该历元的真实 PRN，且个数与星数一致
  const prns = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, ep=V.view.hover;
      const thr=Math.sin(s.mask*Math.PI/180), out=[];
      // 与页面同一条判据：相对天线法线的掩角 **且** 在当地地平线以上
      const K=V.core.dcmEnuToBody(s.trace.data.Yaw[ep],s.trace.data.Pitch[ep],s.trace.data.Roll[ep]);
      for(let i=0;i<s.nSat;i++){
        if(!s.sys.has(s.satSys[i])) continue;
        const o=ep*s.nSat*3+i*3;
        if(s.los[o+2]<=thr) continue;
        const up=K[2]*s.los[o]+K[5]*s.los[o+1]+K[8]*s.los[o+2];
        if(up<=0) continue;
        out.push(s.satSys[i]+s.rinex.sats[i].prn);}
      return {want:out.sort(), n:s.counts[ep]}})()`);
  const listed = (sky.list.match(/[GCRESJI]\d\d/g) || []).slice().sort();
  const wanted = prns.want.slice().sort();   // 页面按星座分组列出，比较必须用集合而非顺序
  // 两张图必须自洽：主图里"地理高度角低于掩角"的星（即在地理正投影上看起来落在
  // 截止圈外），在机体系视图里必须满足「与天线法线夹角 < 90°−掩角」——也就是落在
  // 右图虚线判据圈内。这正是用户问过的那颗星（历元 2798 的 E02/R14）。
  // 要扫多个历元 —— 只查光标所在的那一个会**空跑通过**（多数历元根本没有圈外的星）。
  const pair = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, D=Math.PI/180, T=s.trace.data;
      const thr=Math.sin(s.mask*D), lim=90-s.mask;
      let outside=0, bad=0, worst='', rows=[];
      for (const ep of [0, 680, 1374, 2497, 2798, 4000, 4999]) {
        const K=V.core.dcmEnuToBody(T.Yaw[ep],T.Pitch[ep],T.Roll[ep]);
        for(let i=0;i<s.nSat;i++){
          if(!s.sys.has(s.satSys[i])) continue;
          const o=ep*s.nSat*3+i*3, bz=s.los[o+2];
          const up=K[2]*s.los[o]+K[5]*s.los[o+1]+K[8]*s.los[o+2];
          if(bz<=thr||up<=0) continue;               // 只有计入的才谈得上
          const el=Math.asin(Math.max(-1,Math.min(1,up)))/D;
          if(el>=s.mask) continue;                    // 地理仰角够高，不属本题
          outside++;
          // 真判据：与天线法线的夹角 < 90°−掩角，也就是落在右图虚线圈内
          const ang=Math.acos(Math.max(-1,Math.min(1,bz)))/D;
          if(ang>=lim){ bad++; if(!worst) worst='历元'+ep+' '+s.satSys[i]+s.rinex.sats[i].prn; }
          if(rows.length<4) rows.push('历元'+ep+' '+s.satSys[i]+s.rinex.sats[i].prn+
            '（地理仰角 '+el.toFixed(1)+'°，与法线夹角 '+ang.toFixed(1)+'°< '+lim+'°）');
        }
      }
      return {outside, bad, worst, rows, mask:s.mask};})()`);
  // outside>0 是这条断言**非空跑**的前提：必须真的扫到地理仰角不足的星
  chk('地理仰角低于掩角但仍计入的星，在机体系视图里都落在判据圈内（两图自洽）',
      pair.bad === 0 && pair.outside > 0,
      pair.outside === 0
        ? '扫描的历元里没有地理仰角不足的星，断言空跑 —— 必须换到有这类星的历元'
        : '扫到 ' + pair.outside + ' 颗地理仰角低于 ' + pair.mask + '° 却仍计入，全部满足' +
          '「与法线夹角 < ' + (90 - pair.mask).toFixed(0) + '°」即落在右图虚线圈内（违反 ' +
          pair.bad + ' 颗）' + (pair.bad ? '，例 ' + pair.worst : '') + '。例：' + pair.rows.join('、'));

  chk('星空图逐星编号与缓存 LOS 完全一致',
      prns.n === listed.length && wanted.every((p, i) => p === listed[i]),
      `期望 ${prns.n} 颗 [${wanted.slice(0, 6).join(' ')} …]，页面列出 ${listed.length} 个 [${listed.slice(0, 6).join(' ')} …]`);
  chk('星空图有实际绘制内容', sky.ink > 3000, '着墨像素 ' + sky.ink);
  // 两张星空图必须**等大且左右并列**（用户明确要求），而且都要够大看得清编号。
  // 尺寸从 DOM 现读，不写死数值 —— 写死会在改版时给出假绿/假红。
  const duo = await evalJS(`(()=>{const a=document.getElementById('c3').getBoundingClientRect(),
      b=document.getElementById('c4').getBoundingClientRect();
    return {aw:a.width,ah:a.height,bw:b.width,bh:b.height,ax:a.x,bx:b.x,
            attrA:+document.getElementById('c3').getAttribute('height'),
            attrB:+document.getElementById('c4').getAttribute('height'),
            backingA:document.getElementById('c3').height,
            dpr:window.devicePixelRatio||1};})()`);
  chk('两张星空图等大、左右并列，且不小于 280 px',
      Math.abs(duo.aw - duo.bw) < 0.5 && Math.abs(duo.ah - duo.bh) < 0.5 &&
      duo.bx > duo.ax && duo.ah >= 280,
      `A ${duo.aw}×${duo.ah} @x=${duo.ax.toFixed(0)}，B ${duo.bw}×${duo.bh} @x=${duo.bx.toFixed(0)}（同尺寸、左右并列）`);
  chk('两张星空图画布高度不随重绘增长',
      duo.attrA === duo.attrB && duo.ah === duo.attrA &&
      duo.backingA === Math.round(duo.attrA * duo.dpr),
      `height 属性 A=${duo.attrA} B=${duo.attrB}，后备存储高=${duo.backingA}（期望 ${Math.round(duo.attrA * duo.dpr)}）`);

  // 面板顺序：星空图必须是**第一个** .chartbox（用户要求它排在 ①）。
  // 注意画布 id 与显示顺序故意不一致（c1=星数、c2=PDOP、c3=星空），
  // 所以这里只能按 .chartbox 的出现次序断言，不能按 id 断言。
  const order = await evalJS(
      `Array.from(document.querySelectorAll('.chartbox .t')).map(e=>e.textContent.trim())`);
  chk('星空图排在第一位（显示序号 ①）',
      order.length === 3 && /①/.test(order[0]) && /卫星星空图/.test(order[0]) &&
      /②/.test(order[1]) && /③/.test(order[2]),
      '面板次序：' + order.map(t => t.slice(0, 12)).join(' → '));

  // 方位标注：A 视角（c3）必须是地理 N/S/E/W，不能还是机首/机尾/左翼/右翼；
  // B 视角（c4）是机体系，反过来**必须**有机首/机尾/右翼/左翼。
  // 挂钩 fillText 重画一帧，把真正画到每张画布上的文字抓出来比。
  // 注意钩子挂在 prototype 上、对所有画布生效，所以要按 canvas.id 分开收。
  const drawnBy = await evalJS(`(()=>{
    const P=CanvasRenderingContext2D.prototype, orig=P.fillText, seen={};
    P.fillText=function(t,x,y){ const k=(this.canvas&&this.canvas.id)||'?';
      (seen[k]=seen[k]||[]).push(String(t)); return orig.apply(this,arguments); };
    GNSS_VIEW.drawAll();
    P.fillText=orig;
    return seen;})()`);
  const drawn = drawnBy.c3 || [], drawn4 = drawnBy.c4 || [];
  const want4 = ['N', 'S', 'W', 'E'];
  chk('A 视角四方位标注为地理 N/S/W/E',
      want4.every(d => drawn.includes(d)) &&
      !drawn.some(t => /机首|机尾|左翼|右翼/.test(t)),
      'c3 实际画出的方位文字：' + drawn.filter(t => want4.includes(t) || /翼|首|尾/.test(t)).join(' ')
      + '（共捕获 ' + drawn.length + ' 条 fillText）');
  // B 视角的四个机体方向：参考设计明确要求"正上方永远代表机头方向"，没有罗盘
  // 就必须把机首/机尾/右翼/左翼写出来，否则读者无从判断哪边是机头。
  chk('B 视角标出机首/机尾/右翼/左翼（机体系没有罗盘）',
      ['机首', '机尾', '右翼', '左翼'].every(d => drawn4.includes(d)),
      'c4 实际画出的方位文字：' + drawn4.filter(t => /翼|首|尾/.test(t)).join(' ') +
      '（共捕获 ' + drawn4.length + ' 条 fillText）');
  chk('B 视角画出了与法线的 30°/60° 角距圈标注',
      drawn4.includes('30°') && drawn4.includes('60°'),
      'c4 上的角距标注：' + drawn4.filter(t => /°$/.test(t)).join(' '));

  // 标准底图：三条同心圆（0/30/60°）+ 四条方位直径（N-S、NE-SW、E-W、SE-NW）
  // + 圆心为天顶。挂钩 arc / moveTo / lineTo 抓真实几何，而不是钉"看起来像"。
  // 注意画布坐标是 **CSS 像素**（setTransform 已把 dpr 吃进矩阵），要用 clientWidth。
  // **必须按 canvas.id 过滤**：钩子挂在 prototype 上对所有画布生效，而两张星空图
  // 现在是**同样大小**，圆心都是 (150,150) —— 不过滤就会把 c4 的四个圈一起收进来
  // （实测比例变成 1.051/1.051/1.000/0.876/0.701/0.667/0.350，一度误判成"底图错了"）。
  // 另外 c3 的 60° 圈半径 R/3=39.3 < 40，会被 r>40 的门槛滤掉，所以门槛也放宽。
  const geo = await evalJS(`(()=>{
    const P=CanvasRenderingContext2D.prototype, oa=P.arc, ol=P.lineTo, segs=[];
    const mine=function(){return this.canvas&&this.canvas.id==='c3';};
    P.arc=function(x,y,r){ oa.apply(this,arguments);
      if(mine.call(this)&&r>10) segs.push({kind:'arc', x:x, y:y, r:r}); };
    P.lineTo=function(x,y){ ol.apply(this,arguments);
      if(mine.call(this)&&this.__st)
        segs.push({kind:'seg', x0:this.__st[0], y0:this.__st[1], x:x, y:y}); };
    const om=P.moveTo;
    P.moveTo=function(x,y){ if(mine.call(this)) this.__st=[x,y]; return om.apply(this,arguments); };
    GNSS_VIEW.drawAll();
    P.arc=oa; P.lineTo=ol; P.moveTo=om;
    const cv=document.getElementById('c3'), w=cv.clientWidth, h=cv.clientHeight;
    const cx=w/2, cy=h/2, R=Math.max(40,Math.min(w,h)/2-32);
    const rings=segs.filter(s=>s.kind==='arc'
      && Math.abs(s.x-cx)<1 && Math.abs(s.y-cy)<1).map(s=>s.r).sort((a,b)=>b-a);
    // 方位直径：从圆心出发、终点正好落在外圈 R 上
    const azs=segs.filter(s=>s.kind==='seg'
      && Math.hypot(s.x0-cx,s.y0-cy)<1.5 && Math.abs(Math.hypot(s.x-cx,s.y-cy)-R)<1.5)
      .map(s=>{let a=Math.atan2(s.x-cx, -(s.y-cy))*180/Math.PI; return +(((a%360)+360)%360).toFixed(2);})
      .sort((a,b)=>a-b);
    return {rings, azs, R, cx, cy};})()`);
  // A 视角三条圈（由外向内）：高度角 0° / 30° / 60°，圆心即天顶 90°。
  // 这里**不该**再有掩角圈：掩角定义在天线面法线上，在正投影地理图上画不出正圆，
  // 画了只会误导（此前那个红圈正是用户困惑的来源）。判据统一交给 B 视角。
  const ratio = geo.rings.map(r => r / geo.R);
  chk('A 视角底图为同心圆 0°/30°/60°（圆心=天顶 90°），且不画掩角圈',
      ratio.length === 3 && Math.abs(ratio[0] - 1) < 0.01 &&
      Math.abs(ratio[1] - 2 / 3) < 0.01 && Math.abs(ratio[2] - 1 / 3) < 0.01,
      'R=' + geo.R + '，半径比例 ' + ratio.map(r => r.toFixed(3)).join(' : ') +
      '（期望 1.000 : 0.667 : 0.667→0.333，即 1 : 2/3 : 1/3，共 3 圈）');
  chk('底图为四条方位直径 N-S / NE-SW / E-W / SE-NW',
      geo.azs.length === 4 && [0, 45, 90, 135].every((a, i) =>
        Math.abs(geo.azs[i] - a) < 0.5 || Math.abs(geo.azs[i] - (a + 360)) < 0.5),
      '实测四条直径的方位角：' + geo.azs.join('°, ') + '°（期望 0/45/90/135，各为完整直径）');
  // B 视角要看到"被遮挡的星变红"与"地球遮挡画成空心圈"，必须先勾上显示开关。
  await evalJS('(()=>{const c=document.getElementById("skyMasked");c.checked=true;' +
      'c.dispatchEvent(new Event("change"));return c.checked})()');

  // B 视角（机体系）四张同心圈，由外向内：面板地平线 90° / 角距 60° / 角距 30° /
  // 掩角判据圈 (90°−掩角)。判据圈是**正圆**，半径 (1 − mask/90)·Rp —— 这正是
  // 该视角存在的理由。Rp 的边距常量与 drawPanel 一致（/2 − 18）。
  const pan = await evalJS(`(()=>{
    const P=CanvasRenderingContext2D.prototype, oa=P.arc, arcs=[];
    P.arc=function(x,y,r){ if(this.canvas&&this.canvas.id==='c4')
        arcs.push([+x.toFixed(1),+y.toFixed(1),+r.toFixed(2)]); return oa.apply(this,arguments); };
    GNSS_VIEW.drawAll(); P.arc=oa;
    const cv=document.getElementById('c4'), w=cv.clientWidth, h=cv.clientHeight;
    const Rp=Math.max(30,Math.min(w,h)/2-26);
    // 外圈画了两次（先 fill 再 stroke），按半径去重
    const uniq=[...new Set(arcs.filter(a=>Math.abs(a[0]-w/2)<1&&Math.abs(a[1]-h/2)<1)
                   .map(a=>a[2]))].sort((a,b)=>b-a);
    const dots=arcs.filter(a=>a[2]<4);
    return {ring:uniq, dots:dots.length, Rp, w};})()`);
  // 四圈是**无序集合**：掩角 15° 时判据圈 r=0.833·Rp 落在 60° 圈(0.667)外面，
  // 掩角一大又会落到里面，所以不能按半径排序后逐位比较。
  const pRatio = pan.ring.map(r => r / pan.Rp);
  const pMask = 1 - pair.mask / 90;
  const has = (b) => pRatio.some(r => Math.abs(r - b) < 0.01);
  chk('B 视角判据圈半径 = (1−掩角/90)·Rp，是正圆（掩角真判据）',
      pan.ring.length === 4 && has(1) && has(2 / 3) && has(1 / 3) && has(pMask),
      'Rp=' + pan.Rp + '，四圈半径比例 ' + pRatio.map(r => r.toFixed(3)).join(' / ') +
      '（须同时含 1.000 面板地平线、0.667 角距60°、0.333 角距30°、' +
      pMask.toFixed(3) + ' 掩角判据圈）');
  chk('B 视角画布放大到 ≥280 px',
      await evalJS('document.getElementById("c4").clientWidth') >= 280,
      'CSS 宽=' + await evalJS('document.getElementById("c4").clientWidth') +
      '（曾因只有 150 px 被用户指为"太小"、看不清卫星编号）');

  // B 视角必须给每颗**计入**的星标号，且标号集合 == 该历元的星数缓存。
  // 用户明确抱怨"第二个星空图没标注卫星编号"，这条就是防它退回去。
  const panVis = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, D=Math.PI/180;
      const P=CanvasRenderingContext2D.prototype, of=P.fillText, oa=P.arc, labels=[], arcs=[];
      P.fillText=function(t,x,y){ if(this.canvas&&this.canvas.id==='c4') labels.push(String(t));
        return of.apply(this,arguments); };
      P.arc=function(x,y,r){ if(this.canvas&&this.canvas.id==='c4'&&r<4)
          arcs.push([+x.toFixed(1),+y.toFixed(1),+r.toFixed(2)]); return oa.apply(this,arguments); };
      const ep=V.sky.ep;
      V.drawAll(); P.fillText=of; P.arc=oa;
      const want=[];
      for(let i=0;i<s.nSat;i++){
        if(!s.sys.has(s.satSys[i])) continue;
        const o=ep*s.nSat*3+i*3;
        const up=s.upRow[ep*3]*s.los[o]+s.upRow[ep*3+1]*s.los[o+1]+s.upRow[ep*3+2]*s.los[o+2];
        if(s.los[o+2]>Math.sin(s.mask*D)&&up>0) want.push(s.satSys[i]+s.rinex.sats[i].prn);}
      want.sort();
      return {n:s.counts[ep], want, got:labels.filter(t=>/^[GCRESJI]\\d\\d$/.test(t)).sort(),
              arcs, mask:s.mask};})()`);
  chk('B 视角给每颗计入的星都标了 PRN 编号，且与星数缓存一致',
      panVis.got.length === panVis.n && panVis.n > 0 &&
      panVis.want.every((p, i) => p === panVis.got[i]),
      '该历元计入 ' + panVis.n + ' 颗，页面在 c4 上标出 ' + panVis.got.length +
      ' 个编号 [' + panVis.got.slice(0, 8).join(' ') + (panVis.got.length > 8 ? ' …' : '') + ']');

  // **真正**的语义断言：钩住 c4 上真正画出来的点，比对它们相对虚线圈的位置。
  //   实心 r=3   -> 计入（面板可见且地平线以上），必须**全部**落在虚线圈内
  //   空心 r=2   -> 地球遮挡，**必须全部**落在虚线圈外（否则"圈内可见"是假的）
  //   实心 r=1.7 -> 被面板边缘挡住，必须全部落在虚线圈外（越出掩角圈就该变红）
  // 按半径分类，三类的几何条件都必须成立，且数量与独立复算一致。
  const panGeom = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, D=Math.PI/180;
      // Rp / 圆心都从 c4 的**实测尺寸**算，改版不会让这条断言悄悄失效
      const cw=document.getElementById('c4').clientWidth, ch=document.getElementById('c4').clientHeight;
      const Rp=Math.max(30,Math.min(cw,ch)/2-26), ccx=cw/2, ccy=ch/2;
      const rr=Rp*(1-s.mask/90), thr=Math.sin(s.mask*D), keep=V.sky.ep;
      const res={vis:[],earth:[],blocked:[],rr};
      for (const ep of [0,680,1374,2497,2798,4000,4999]) {
        const oa=CanvasRenderingContext2D.prototype.arc, A=[];
        CanvasRenderingContext2D.prototype.arc=function(x,y,r){
          if(this.canvas&&this.canvas.id==='c4'&&r<4) A.push([+x.toFixed(1),+y.toFixed(1),+r.toFixed(2)]);
          return oa.apply(this,arguments); };
        V.sky.ep=ep; V.drawAll();
        CanvasRenderingContext2D.prototype.arc=oa;
        const rad=p=>+Math.hypot(p[0]-ccx,p[1]-ccy).toFixed(2);
        const vis=A.filter(p=>Math.abs(p[2]-3)<0.01).map(rad);
        const earth=A.filter(p=>Math.abs(p[2]-2)<0.01).map(rad);
        const blk=A.filter(p=>Math.abs(p[2]-1.7)<0.01).map(rad);
        // 独立复算数量：空心圈只画"面板朝得到、却被地球挡着"的那一类，
        // 两条判据都不满足的星（每历元约 90 颗）不画，纯属噪声。
        let nv=0,ne=0,nb=0;
        for(let i=0;i<s.nSat;i++){
          if(!s.sys.has(s.satSys[i])) continue;
          const o=ep*s.nSat*3+i*3, bz=s.los[o+2];
          const up=s.upRow[ep*3]*s.los[o]+s.upRow[ep*3+1]*s.los[o+1]+s.upRow[ep*3+2]*bz;
          if(bz>thr){ if(up<=0) ne++; else nv++; } else if(up>0) nb++;}
        res.vis.push([ep,vis,nv]); res.earth.push([ep,earth,ne]); res.blocked.push([ep,blk,nb]);
      }
      V.sky.ep=keep; V.drawAll();
      return res;})()`);
  {
    const rr = panGeom.rr, TOL = 0.75;   // r 四舍五入到 0.01，留 0.75 px 容差
    const badV = panGeom.vis.flatMap(([ep, rs, nv]) =>
      rs.filter(r => r > rr + TOL).map(r => `历元${ep} r=${r}`));
    const badB = panGeom.blocked.flatMap(([ep, rs]) =>
      rs.filter(r => r < rr - TOL).map(r => `历元${ep} r=${r}`));
    const nCnt = panGeom.vis.reduce((a, b) => a + b[2], 0);
    const vCnt = panGeom.vis.reduce((a, b) => a + b[1].length, 0);
    const eCnt = panGeom.earth.reduce((a, b) => a + b[1].length, 0);
    const nE = panGeom.earth.reduce((a, b) => a + b[2], 0);
    const nB = panGeom.blocked.reduce((a, b) => a + b[1].length, 0);
    const inCircle = panGeom.earth.reduce((a, b) =>
      a + b[1].filter(r => r < rr - TOL).length, 0);
    const edgeCnt = panGeom.earth.reduce((a, b) =>
      a + b[1].filter(r => r >= rr - TOL).length, 0);
    const outEarth = panGeom.earth.flatMap(([ep, rs]) =>
      rs.filter(r => r > rr + TOL).map(r => `历元${ep} r=${r}（判据圈 ${rr.toFixed(2)}）`));
    chk('B 视角：实心大点（计入）全部在虚线圈内，且数量 == 独立复算',
        badV.length === 0 && vCnt === nCnt && vCnt > 0,
        '判据圈半径 ' + rr.toFixed(2) + ' px；7 个历元共画出 ' + vCnt + ' 个实心计入点，' +
        '独立复算 ' + nCnt + ' 个，越圈的 ' + badV.length + ' 个' +
        (badV.length ? '（' + badV.slice(0, 3).join('、') + '）' : ''));
    chk('B 视角：被面板遮挡的星全部落在虚线圈外（越出即越圈，无一例外）',
        badB.length === 0 && nB > 0,
        '共 ' + nB + ' 个小红点，越圈的 ' + badB.length + ' 个');
    // 地球遮挡**不是**几何越圈条件：面板朝得很高时，一颗地理仰角为负的星
    // 完全可以落在判据圈**内**（它在面板朝向内，只是被地球本体挡着）。
    // 所以正确的不变量是"它必须画成空心圈、且不计入"，而不是"它必须在圈外"——
    // 上一版断言正是这个错误，被 42 个反例顶穿。现在空心圈**按定义**就在圈内。
    // 且"不越圈"是几何恒等式：收圈条件 bz > sin(掩角) 即 th = acos(bz) < 90°−掩角，
    // 半径 th/90·Rp ≤ (1−掩角/90)·Rp = 判据圈半径。故此处只钉"没有越圈的"。
    // 注意**不能**钉"全部严格小于 rr−TOL"：bz 恰好贴着掩角时半径与 rr 只差零点几
    // 像素（历元 680 有一颗 bz=0.26399 对 sin15°=0.258819，只高 0.005），
    // 而量测坐标只到 0.1 px，写死余量就是拿测量噪声当缺陷。
    chk('B 视角：地球遮挡的星画成圈内空心圈（不与"计入"的实心点混淆），数量吻合',
        eCnt > 0 && eCnt === nE && outEarth.length === 0,
        '空心圈 ' + eCnt + ' 个 == 独立复算 ' + nE + ' 个（bz>sin掩角 但 up<=0），' +
        '判据圈内 ' + inCircle + ' + 贴边 ' + edgeCnt + '（余量 ' + TOL + ' px 内）/ ' + eCnt +
        '，越圈 ' + outEarth.length + ' —— 面板朝得到、地球挡着；' +
        '两条判据都不满足的星不画，避免 ~90 个噪声点淹没图面' +
        (outEarth.length ? '　【圈外】' + outEarth.slice(0, 5).join('、') : ''));
  }
  chk('底图不含掩角球冠 / 天线法线注记',
      !drawn.some(t => /可视区边界|天线法线/.test(t)),
      '画布上的非卫星文字：' + drawn.filter(t => !/^[GCRESJI]\d\d$/.test(t)).join(' '));

  // 方位标注必须登记进标号避让的障碍集合：斜方位（SW/NW/NE/SE）离圆心最远，
  // 恰好落在卫星编号堆里，不登记就会被编号盖成"S**V R02**"。
  // 断言方式：抓 c3 上每条 fillText 的**实际坐标**，检查 PRN 与方位文字不重叠。
  const azHit = await evalJS(`(()=>{const V=GNSS_VIEW, keep=V.sky.ep;
      const P=CanvasRenderingContext2D.prototype, of=P.fillText;
      const AZB=new Set(['N','S','E','W','NE','SE','SW','NW']);
      const PRN=/^[GCRESJI]\\d\\d$/;
      let bad=[], nAz=0, nPrn=0;
      for (const ep of [0,680,1374,2497,2798,4000,4999]) {
        const seen=[];
        // 用**真实字宽**判断重叠：方位文字里 'S' 只有 ~7 px 宽，
        // 若按固定阈值 20 px 判，会把避让算法正当让出的 18 px 也误判成重叠。
        P.fillText=function(t,x,y){
          if(this.canvas&&this.canvas.id==='c3'&&(AZB.has(t)||PRN.test(t)))
            seen.push([t,x,y,this.measureText(t).width]);
          return of.apply(this,arguments); };
        V.sky.ep=ep; V.drawAll();
        const azs=seen.filter(e=>AZB.has(e[0])), prns=seen.filter(e=>PRN.test(e[0]));
        nAz+=azs.length; nPrn+=prns.length;
        for(const [,x,y,pw] of prns) for(const [t,ax,ay,aw] of azs)
          if(Math.abs(x-ax)<(aw+pw)/2-2 && Math.abs(y-ay)<6.5) bad.push(ep+':'+t);
      }
      P.fillText=of; V.sky.ep=keep; V.drawAll();
      return {bad,nAz,nPrn};})()`);
  chk('方位标注不被卫星编号覆盖（登记进避让障碍集合）',
      azHit.bad.length === 0 && azHit.nAz > 0 && azHit.nPrn > 0,
      `7 个历元共 ${azHit.nAz} 条方位文字 / ${azHit.nPrn} 条卫星编号，重叠 ${azHit.bad.length} 处` +
      (azHit.bad.length ? '（' + azHit.bad.slice(0, 5).join('、') + '）' : ''));

  // 编号避让的完整不变量（三者缺一不可，全部用**实际字宽**判定）：
  //   ① 编号之间不重叠  ② 编号不压住星点  ③ 没有编号掉进"压在点上"的兜底分支
  // 历史教训：② 曾长期为假而页面毫无异常 —— drawPanel 把星点画了却**没登记成障碍**，
  // 而起始半径 7 px 小于半个字宽（"C22" 半宽约 8.5 px），第一个候选位置按几何
  // 就必然盖住自己的点。只缩小字号能减轻症状，但治不了根，所以这里钉死 ②。
  const decl = await evalJS(`(()=>{const V=GNSS_VIEW, keep=V.sky.ep;
      const P=CanvasRenderingContext2D.prototype, of=P.fillText, oa=P.arc;
      const PRN=t=>{t=String(t); if(t.length!==3) return false;
        const A=t.charCodeAt(0),B=t.charCodeAt(1),C=t.charCodeAt(2);
        return A>=65&&A<=90&&B>=48&&B<=57&&C>=48&&C<=57;};
      const badLbl=[], badDot=[], badAnn=[]; let nLbl=0, nDot=0, nAnn=0;
      // 机体系注记（画在标号之后，同样会被压住）
      const ANN=new Set(['机首','机尾','左翼','右翼','30°','60°']);
      for (const ep of [0,680,1374,2497,2798,4000,4999]) {
        const dots={}, lbl={}; let ann=[];
        P.arc=function(x,y,r){ if(r>=2.8&&r<=3.3&&this.canvas) (dots[this.canvas.id]=dots[this.canvas.id]||[]).push({x:x,y:y}); return oa.apply(this,arguments); };
        P.fillText=function(t,x,y){ if(this.canvas&&this.canvas.id){
          const rec={t:String(t),x:x,y:y,w:this.measureText(String(t)).width,
                     al:this.textAlign,b:this.textBaseline};
          if(PRN(t)) (lbl[this.canvas.id]=lbl[this.canvas.id]||[]).push(rec);
          // 必须按画布分流：'30°'/'60°' 在 c3 上是高度角标注，在 c4 上才是夹角圈标注，
          // 不分流就会拿 A 视角的注记去判 B 视角的编号（会报出根本不存在的碰撞）。
          else if(ANN.has(rec.t)&&this.canvas.id==='c4') (ann=ann||[]).push(rec);
        } return of.apply(this,arguments); };
        V.sky.ep=ep; V.drawAll();
        for (const id of ['c3','c4']) {
          const L=lbl[id]||[], D2=dots[id]||[];
          nLbl+=L.length; nDot+=D2.length;
          // 注记按 textAlign 还原真实占位：机首/机尾居中，左翼右对齐，右翼左对齐
          const an0 = id==='c4' ? ann : [];
          nAnn += an0.length;
          for(let i=0;i<L.length;i++){
            for(let j=i+1;j<L.length;j++)
              if(Math.abs(L[i].x-L[j].x)<(L[i].w+L[j].w)/2-1 && Math.abs(L[i].y-L[j].y)<9.5)
                badLbl.push(ep+':'+id+':'+L[i].t+'/'+L[j].t);
            for(const d of D2)
              if(Math.abs(L[i].x-d.x)<(L[i].w+5)/2 && Math.abs(L[i].y-d.y)<9.5)
                badDot.push(ep+':'+id+':'+L[i].t);
            for(const a of an0){
              const ax = a.al==='center' ? a.x - a.w/2 : a.al==='right' ? a.x-a.w : a.x;
              // 编号占位 [Lx±w/2]×[Ly±5.5]，注记占位 [ax, ax+aw]×[ay±6]，求区间相交
              if (L[i].x-L[i].w/2 < ax+a.w && ax < L[i].x+L[i].w/2 && Math.abs(L[i].y-a.y) < 6)
                badAnn.push(ep+':'+L[i].t+'@'+L[i].x.toFixed(0)+','+L[i].y.toFixed(0)+
                            '/'+a.t+'@ax'+(ax+a.w/2).toFixed(0)+','+a.y.toFixed(0)+
                            ' al='+a.al+' w='+a.w.toFixed(0));
            }
          }
        }
      }
      P.fillText=of; P.arc=oa; V.sky.ep=keep; V.drawAll();
      return {badLbl,badDot,badAnn,nLbl,nDot,nAnn,
              s3:document.getElementById('s3').textContent,
              s4:document.getElementById('s4').textContent};})()`);
  chk('两张星空图：卫星编号之间互不重叠（实测字宽判定）',
      decl.badLbl.length === 0 && decl.nLbl > 200,
      `7 个历元共 ${decl.nLbl} 条编号，重叠 ${decl.badLbl.length} 处` +
      (decl.badLbl.length ? '（' + decl.badLbl.slice(0, 5).join('、') + '）' : ''));
  chk('两张星空图：编号不压在卫星圆点上（星点已登记为避让障碍）',
      decl.badDot.length === 0 && decl.nDot > 200,
      `${decl.nDot} 个圆点，重叠 ${decl.badDot.length} 处` +
      (decl.badDot.length ? '（' + decl.badDot.slice(0, 5).join('、') + '）' : ''));
  chk('B 视角：机首/机尾/左翼/右翼 与 30°/60° 注记不被编号压住',
      decl.badAnn.length === 0 && decl.nAnn === 42,
      `7 个历元共 ${decl.nAnn} 条注记，重叠 ${decl.badAnn.length} 处` +
      (decl.badAnn.length ? '（' + decl.badAnn.slice(0, 5).join('、') + '）' : ''));
  // 两个视角的状态行措辞不同：A 视角写"压在**圆**点上"（连同下面的 PRN 列表注记），
  // B 视角写"压在点上"。只 grep 前者会把 A 视角的兜底分支整个漏掉 —— 上一版
  // 就是这样让历元 4000 的 E36 顶着"编号压在圆点上"照样全绿的。
  chk('两张星空图：没有编号走"压在点上"的兜底分支',
      !/压在[圆]?点上/.test(decl.s3) && !/压在[圆]?点上/.test(decl.s4),
      's3 = ' + decl.s3.slice(-34) + '　s4 = ' + decl.s4.slice(0, 46));

  // 状态行里的天线法线 az/el 必须等于独立算一遍的 DCM 结果
  //（ENU 下的 boresight：body Z 轴 = K 的第 3 行）。
  const bs = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, ep=V.view.hover, T=s.trace.data, D=Math.PI/180;
      const K=V.core.dcmEnuToBody(T.Yaw[ep],T.Pitch[ep],T.Roll[ep]);
      const az=Math.atan2(K[6],K[7])/D, el=Math.asin(K[8])/D;
      const m=document.getElementById('s3').textContent.match(/天线法线 az (-?\\d+)° el (-?\\d+)°/);
      return {want:[Math.round(az), Math.round(el)], got:m?[+m[1],+m[2]]:null, raw:[az,el]}})()`);
  chk('天线法线方位/仰角与独立 DCM 计算一致',
      !!bs.got && bs.got[0] === bs.want[0] && bs.got[1] === bs.want[1],
      `页面 az=${bs.got && bs.got[0]}° el=${bs.got && bs.got[1]}°，` +
      `独立算 az=${bs.raw[0].toFixed(3)}° el=${bs.raw[1].toFixed(3)}°`);

  // 可视判据本身：LOS 缓存是**机体系**，机体系 Z 就是天线法线，
  // 所以「可视」必须等价于与法线的角距 < 90° − 掩角。
  const ang = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, D=Math.PI/180;
      const thr=Math.sin(s.mask*D), lim=90-s.mask, out=[];
      for (const ep of [0, 1000, 2497, 4000, 4999]) {
        let worst=0, n=0, bad=0;
        for(let i=0;i<s.nSat;i++){
          if(!s.sys.has(s.satSys[i])) continue;
          const bz=s.los[ep*s.nSat*3+i*3+2];
          if(bz>thr){ n++;
            const a=Math.acos(Math.max(-1,Math.min(1,bz)))/D;
            if(a>worst) worst=a; if(a>lim+1e-9) bad++; }
        }
        out.push({ep, n, worst, bad});
      }
      return {out, lim}})()`);
  chk('每颗可视星相对天线法线的角距均小于 90°−掩角',
      ang.out.every(o => o.bad === 0 && o.worst <= ang.lim + 1e-9),
      ang.out.map(o => `历元 ${o.ep}: ${o.n} 颗 / 最大 ${o.worst.toFixed(3)}° ≤ ${ang.lim}°`).join('；'));

  // 地球遮挡回归：历史上 roll 摆到 ±54°、法线仰角低到 35.6° 时，
  // 掩角 0° 有 5.6% 的"可视星"其实在地平线以下，星空图上就是跑到外圈之外的点。
  // 逐历元核 counts[e] 是否恰好等于「z>sin(掩角) 且 up>0」的星数。
  const occ = await evalJS(`(()=>{const V=GNSS_VIEW, s=V.state, D=Math.PI/180, T=s.trace.data;
      const thr=Math.sin(s.mask*D); let bad=0, firstBad=-1, tot=0;
      for(let ep=0;ep<s.trace.n;ep++){
        const K=V.core.dcmEnuToBody(T.Yaw[ep],T.Pitch[ep],T.Roll[ep]);
        let n=0;
        for(let i=0;i<s.nSat;i++){
          if(!s.sys.has(s.satSys[i])) continue;
          const o=ep*s.nSat*3+i*3;
          if(s.los[o+2]<=thr) continue;
          if(K[2]*s.los[o]+K[5]*s.los[o+1]+K[8]*s.los[o+2]<=0) continue;
          n++;
        }
        tot+=n;
        if(n!==s.counts[ep]){ bad++; if(firstBad<0) firstBad=ep; }
      }
      // 星空图实际画出的卫星圆点必须全在外圈之内：挂钩 arc 取半径 ~3.1 的那些圆心。
      // （不能用"圈外着墨像素"来判：方位标注本来就画在圈外。）
      const P=CanvasRenderingContext2D.prototype, oa=P.arc, dots=[];
      // 必须限定 this.canvas 是 c3 —— 钩子挂在原型上，图②/③ 的光标圈也会被抓进来
      P.arc=function(x,y,r){
        if(this.canvas && this.canvas.id==='c3' && r>2.5&&r<4) dots.push([x,y,r]);
        return oa.apply(this,arguments); };
      V.drawAll();
      P.arc=oa;
      const cv=document.getElementById('c3'), w=cv.clientWidth, h=cv.clientHeight;
      const R=Math.max(40,Math.min(w,h)/2-32);
      let outside=0, maxr=0;
      for(const d of dots){ const r=Math.hypot(d[0]-w/2,d[1]-h/2);
        if(r+d[2]>R+0.5) outside++; if(r>maxr) maxr=r; }
      return {bad, firstBad, tot, outside, ndots:dots.length, maxr, R};})()`);
  chk('星数已扣除地球遮挡（无地平线以下的星被计入）',
      occ.bad === 0,
      occ.bad === 0 ? '5000 个历元的星数与「z>sin(掩角) 且 up>0」逐历元一致，合计 ' + occ.tot + ' 星次'
                    : '不一致 ' + occ.bad + ' 处，首例历元 ' + occ.firstBad);
  chk('星空图上没有任何卫星点落到外圈之外',
      occ.outside === 0,
      '当前历元 ' + occ.ndots + ' 个圆点，最远半径 ' + occ.maxr.toFixed(1) +
      ' ≤ 外圈 R=' + occ.R + '；越界 ' + occ.outside + ' 个' +
      '（此前 roll 机动历元的点会跑到外圈之外）');
  // 掩角变化必须同步反映到星空图（虚线圈 + 可视集合）
  await evalJS(`(()=>{const m=document.getElementById('mask');m.value=40;
      m.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await sleep(300);
  const sky40 = await evalJS(`(()=>{const s=GNSS_VIEW.state;
      return {list:document.getElementById('prn').textContent, st:document.getElementById('s3').textContent}})()`);
  await evalJS(`(()=>{const m=document.getElementById('mask');m.value=15;
      m.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await sleep(300);
  const n40 = (sky40.list.match(/[GCRESJI]\d\d/g) || []).length;
  chk('掩角滑到 40° 时星空图只剩掩角圈内可见', n40 > 0 && n40 < sky.count,
      `掩角 40° -> ${n40} 颗，掩角 15° -> ${sky.count} 颗（同一历元 ${sky.ep}）`);

  console.log('\n=== 导出 CSV（掩角 15°、全部 7 系统）===');
  await evalJS('document.getElementById("bExp").click()');
  let files = [];
  for (let i = 0; i < 40 && !files.length; i++) { await sleep(250); files = fs.readdirSync(DL).filter(f => f.endsWith('.csv')); }
  chk('CSV 已通过 Blob 下载到磁盘', files.length === 1, files.join(','));
  if (files.length) {
    const got = path.join(DL, files[0]);
    const buf = fs.readFileSync(got);
    const lines = buf.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    const traceHead = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0].trim();
    chk('文件名含掩角与星座标记', /^gnss_pdop_mask15\.0_CEGIJRS\.csv$/.test(files[0]), files[0]);
    chk('UTF-8 BOM（Excel 友好）', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
    chk('表头 = 原始 10 列 + Visible_Count + PDOP + PRN_label',
        lines[0] === traceHead + ',Visible_Count,PDOP,PRN_label', lines[0]);
    // PRN_label 内含逗号，必须加引号；否则解析器会把一行拆成多列
    chk('PRN_label 列带引号且首行非空',
        /"\{[A-Z]\d\d(,[A-Z]\d\d)*\}"$/.test(lines[1]),
        lines[1].slice(-70));
    chk('行数 = 5000 数据行', lines.length === 5001,
        (lines.length - 1) + ' 行，' + (buf.length / 1024).toFixed(0) + ' KB');
    fs.copyFileSync(got, path.join(BUILD, 'e2e_export.csv'));
    console.log('  已另存 build/e2e_export.csv 供 Python 独立逐历元核对');
  }

  console.log('\n=== 批量任务 · 模式 ①（固定轨迹 × 多星历）===');
  // 复用同一份轨迹当"固定文件"，同一份星历当"批量文件"（同一份重复两次）——
  // 这样两个任务锚定到同一时刻，结果必须逐位相同，正好用来验证锚定与流水线的确定性。
  {
    await evalJS('document.getElementById("bBatch").click()');
    await sleep(300);
    chk('批量浮层已打开', await evalJS('document.getElementById("batch").classList.contains("on")'));
    // 模式 ① 固定的是**轨迹**、批量的是**星历**（早期版本这里写反过）
    chk('模式① 固定文件标签 = 轨迹、批量标签 = 星历',
        await evalJS('document.getElementById("bLblFixed").textContent.includes("轨迹") &&' +
                     'document.getElementById("bLblMany").textContent.includes("星历")'),
        await evalJS('document.getElementById("bLblFixed").textContent + " / " +' +
                     'document.getElementById("bLblMany").textContent'));
    chk('模式① accept 与文件类型相符',
        await evalJS('document.getElementById("bFixed").accept.includes(".csv") &&' +
                     'document.getElementById("bMany").accept.includes(".rnx")'));
    chk('单任务界面未被改动（结果仍在）',
        (await evalJS('GNSS_VIEW.state.counts.length')) === 5000);

    const doc2 = await send('DOM.getDocument', { depth: -1 });
    // 8 MB 星历解析要时间，不能用固定 sleep —— 轮询到条件成立为止
    const setFiles = async (sel, fl, until) => {
      const q = await send('DOM.querySelector', { nodeId: doc2.result.root.nodeId, selector: sel });
      await send('DOM.setFileInputFiles', { files: fl, nodeId: q.result.nodeId });
      for (let i = 0; i < 200; i++) { await sleep(200); if (await evalJS(until)) return true; }
      return false;
    };
    const okFixed = await setFiles('#bFixed', [CSV],
      'GNSS_VIEW.batch.fixed && document.getElementById("bFixedName").textContent.includes("行")');
    const okMany = await setFiles('#bMany', [RNX, RNX],
      'GNSS_VIEW.batch.many.length === 2 && !document.getElementById("bManyName").textContent.includes("解析中")');
    chk('固定轨迹解析完成', okFixed,
        await evalJS('document.getElementById("bFixedName").textContent'));
    chk('批量星历解析完成（2 份）', okMany,
        await evalJS('document.getElementById("bManyName").textContent') +
        (okMany ? '' : '  错误: ' + await evalJS(
          'GNSS_VIEW.batch.many.map(m=>m.name+":"+(m.err||("ok/"+(m.obj?m.obj.sats.length+"星":"null")))).join(" | ")')));

    chk('固定文件与批量文件均已解析',
        await evalJS('GNSS_VIEW.batch.fixed && GNSS_VIEW.batch.many.length === 2'),
        await evalJS('document.getElementById("bManyName").textContent'));
    void okFixed; void okMany;
    chk('预览表已生成 2 行任务', await evalJS('GNSS_VIEW.batch.tasks.length') === 2);
    chk('起始按钮已解锁', !(await evalJS('document.getElementById("bGo").disabled')));

    // 锚定日期必须取电文最多的那天（09-26），不是覆盖起点的 09-25
    const anc = await evalJS('GNSS_VIEW.batch.tasks.map(t=>' +
      't.anchor.day.y+"-"+String(t.anchor.day.mo).padStart(2,"0")+"-"+String(t.anchor.day.d).padStart(2,"0"))');
    chk('锚定日期 = 电文最多的 09-26（非覆盖起点的 09-25）',
        anc.every(d => d === '2026-09-26'), JSON.stringify(anc));
    chk('覆盖判定为 ok（00:00 锚点落在当日覆盖内）',
        await evalJS('GNSS_VIEW.batch.tasks.every(t=>t.cover==="ok")'),
        await evalJS('GNSS_VIEW.batch.tasks.map(t=>t.cover).join(",")'));
    chk('预览表无 out 告警',
        !(await evalJS('!!document.querySelector("#bPrev .bwarn.err")')));

    // 掩角 0° 让可见星更多，也避开 PDOP 在低仰角下的退化
    await evalJS('(()=>{const m=document.getElementById("bMask");m.value=0;' +
                 'm.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await evalJS('document.getElementById("bGo").click()');
    let bdone = false;
    for (let i = 0; i < 300 && !bdone; i++) {
      await sleep(250);
      bdone = !(await evalJS('document.getElementById("bProg").classList.contains("on")'));
    }
    chk('批量仿真完成', bdone && (await evalJS('GNSS_VIEW.batch.runs.length')) === 2,
        '完成 ' + (await evalJS('GNSS_VIEW.batch.runs.length')) + ' 项');
    chk('结果面板已显示',
        await evalJS('document.getElementById("bResPanel").style.display') !== 'none');

    const bs = await evalJS('GNSS_VIEW.batch.runs.map(r=>({' +
      'name:r.name,mean:+r.stats.mean.toFixed(4),pmean:+r.stats.pmean.toFixed(4),' +
      'drop:r.stats.drop,n:r.nEp}))');
    if (!bs.length) { console.log('  批量无结果，跳过后续断言'); }
    else {
    console.log('  批量结果: ' + JSON.stringify(bs[0]));
    chk('每个任务 5000 历元', bs.every(b => b.n === 5000));
    chk('同一星历跑两次结果逐位相同（锚定与流水线确定）',
        bs[0].mean === bs[1].mean && bs[0].pmean === bs[1].pmean,
        bs.map(b => b.mean).join(' vs '));
    chk('掩角 0° 的平均星数 > 单任务 15° 的 53.413',
        bs[0].mean > 53.4, '' + bs[0].mean);
    chk('过期率为 0（锚点落在覆盖内）', bs.every(b => b.drop === 0));
    }

    // 视图切换：四个 tab 都要能画出东西且不抛异常
    for (const v of ['trend', 'dist', 'sum', 'delta']) {
      await evalJS(`document.querySelector('#bTabs button[data-v="${v}"]').click()`);
      await sleep(250);
      const ok = await evalJS(`document.getElementById("bView").innerHTML.length > 40`);
      chk('视图 ' + v + ' 渲染成功', ok);
    }
    // 切到汇总表核对列
    await evalJS('document.querySelector(\'#bTabs button[data-v="sum"]\').click()');
    await sleep(200);
    chk('汇总表含过期率列', await evalJS(
      'document.getElementById("bView").textContent.includes("过期率")'));

    /* 纵轴口径切换。回归点是：Δ 口径下**基准自己也必须是 0**。
     * 曾经写成 `counts - (i !== baseline ? base : 0)`，基准被特殊对待画了绝对值，
     * 于是标着「Δ 相对基准」的图上基准线停在 ~66 而其余线在 0，肉眼可见地自相矛盾。*/
    await evalJS('document.querySelector(\'#bTabs button[data-v="sum"]\').click()');
    await sleep(200);
    chk('非对比视图下纵轴切换按钮隐藏', await evalJS(
      'document.getElementById("bScale").style.display === "none"'));
    await evalJS('document.querySelector(\'#bTabs button[data-v="delta"]\').click()');
    await sleep(200);
    chk('对比曲线下纵轴切换按钮可见', await evalJS(
      'document.getElementById("bScale").style.display !== "none"'));
    // Δ 口径：每条序列减去基准；基准与自身的差必然逐点为 0
    const dNote = await evalJS('document.getElementById("bNote").textContent');
    chk('默认纵轴口径为 Δ 基线', dNote.includes('本任务可视星数'), dNote.slice(0, 30));
    await evalJS('document.getElementById("bScale").click()');
    await sleep(250);
    const absState = await evalJS('(()=>{return {' +
      'd:GNSS_VIEW.batch.delta,' +
      'lbl:document.getElementById("bScale").textContent,' +
      'note:document.getElementById("bNote").textContent}})()');
    chk('切到绝对值后状态、按钮文案、说明三者同步',
        absState.d === false && absState.lbl.includes('绝对值') &&
        absState.note.includes('纵轴为可视星数') && !absState.note.includes('本任务可视星数'),
        JSON.stringify(absState).slice(0, 90));
    await evalJS('document.getElementById("bScale").click()');
    await sleep(250);
    chk('可切回 Δ 口径',
        (await evalJS('document.getElementById("bNote").textContent')).includes('本任务可视星数'));

    // 起始时刻提示语必须随模式变：早先它写死了「模式 ②」，模式 ① 下也在说模式 ②
    const hint1 = await evalJS('document.getElementById("bHmsHint").textContent');
    chk('模式① 的起始时刻提示描述锚定日期', hint1.includes('电文最多'), hint1.slice(0, 24));
    await evalJS('document.querySelector(\'input[name="bmode"][value="2"]\').click()');
    await sleep(200);
    const hint2 = await evalJS('document.getElementById("bHmsHint").textContent');
    chk('模式② 的起始时刻提示描述共用时刻', hint2.includes('共用'), hint2.slice(0, 24));
    await evalJS('document.querySelector(\'input[name="bmode"][value="1"]\').click()');
    await sleep(200);
  }

  console.log('\n=== 批量任务 · 模式 ②（固定星历 × 多轨迹）===');
  {
    await evalJS('document.querySelector(\'input[name=bmode][value="2"]\').click()');
    await sleep(250);
    chk('模式切换后固定文件标签改为星历',
        (await evalJS('document.getElementById("bLblFixed").textContent')).includes('星历'),
        await evalJS('document.getElementById("bLblFixed").textContent'));
    const doc3 = await send('DOM.getDocument', { depth: -1 });
    const setF3 = async (sel, fl, until) => {
      const q = await send('DOM.querySelector', { nodeId: doc3.result.root.nodeId, selector: sel });
      await send('DOM.setFileInputFiles', { files: fl, nodeId: q.result.nodeId });
      for (let i = 0; i < 200; i++) { await sleep(200); if (await evalJS(until)) return true; }
      return false;
    };
    chk('模式② 固定星历解析完成', await setF3('#bFixed', [RNX],
      'GNSS_VIEW.batch.fixed && document.getElementById("bFixedName").textContent.includes("颗星")'));
    chk('模式② 批量轨迹解析完成', await setF3('#bMany', [CSV, CSV],
      'GNSS_VIEW.batch.many.length === 2 && !document.getElementById("bManyName").textContent.includes("解析中")'));

    chk('模式② 任务数为 2', (await evalJS('GNSS_VIEW.batch.tasks.length')) === 2);
    chk('模式② 所有任务共用同一 t0',
        await evalJS('new Set(GNSS_VIEW.batch.tasks.map(t=>t.t0Gps)).size') === 1,
        await evalJS('GNSS_VIEW.batch.tasks.map(t=>t.t0Gps).join(",")'));
    chk('模式② 网格一致性标注为「一致」',
        await evalJS('document.getElementById("bPrev").textContent.includes("一致")'));
    chk('模式② 无网格不一致告警',
        !(await evalJS('document.getElementById("bPrev").textContent.includes("不一致")')));

    await evalJS('document.getElementById("bGo").click()');
    let d2 = false;
    for (let i = 0; i < 300 && !d2; i++) {
      await sleep(250);
      d2 = !(await evalJS('document.getElementById("bProg").classList.contains("on")'));
    }
    const r2 = await evalJS('GNSS_VIEW.batch.runs.map(r=>+r.stats.mean.toFixed(4))');
    chk('模式② 完成 2 项', r2.length === 2, JSON.stringify(r2));
    chk('模式② 同一轨迹两次结果相同', r2.length === 2 && r2[0] === r2[1], r2.join(' vs '));
    chk('模式② 全部任务共用同一绝对时刻',
        await evalJS('new Set(GNSS_VIEW.batch.runs.map(r=>r.t0Gps)).size') === 1);
  }

  console.log('\n=== 批量 CSV 导出 ===');
  {
    fs.rmSync(DL, { recursive: true, force: true });
    fs.mkdirSync(DL, { recursive: true });
    await evalJS('document.getElementById("bExpSum").click()');
    let bf = [];
    for (let i = 0; i < 40 && !bf.length; i++) { await sleep(250); bf = fs.readdirSync(DL).filter(f => f.endsWith('.csv')); }
    chk('汇总 CSV 已下载', bf.length === 1, bf.join(','));
    if (bf.length) {
      const L = fs.readFileSync(path.join(DL, bf[0]), 'utf8').replace(/^﻿/, '').trim().split('\r\n');
      chk('汇总表头含 drop_rate', L[0].includes('drop_rate'), L[0]);
      chk('汇总 CSV 2 行数据', L.length === 3, L.length + ' 行');
      chk('汇总 CSV 文件名含掩角', /^batch_summary_mask0\.0\.csv$/.test(bf[0]), bf[0]);
    }
    await evalJS('document.getElementById("bExpRuns").click()');
    bf = [];
    for (let i = 0; i < 60 && !bf.length; i++) { await sleep(250); bf = fs.readdirSync(DL).filter(f => f.startsWith('batch_runs')); }
    chk('逐历元 CSV 已下载', bf.length === 1, bf.join(','));
    if (bf.length) {
      const L = fs.readFileSync(path.join(DL, bf[0]), 'utf8').replace(/^﻿/, '').trim().split('\r\n');
      chk('逐历元表头正确',
          L[0] === 'task,t0_utc,epoch,t_rel_s,visible_count,pdop,drop_rate', L[0]);
      chk('逐历元 CSV = 2 任务 × 5000 历元 + 表头', L.length === 10001, L.length + ' 行');
    }
  }

  console.log('\n=== 批量任务：切模式保留工作区现场 ===');
  {
    /* 用户报的原问题：切模式时工作区里的输入和跑出的结果被一并清空。
     * 早期版本的 syncMode 无条件把 fixed/many/tasks/runs 清零。现在每个模式一份
     * 独立现场，切模式只换 slot。断言必须覆盖「切走再切回，结果逐位相同」，
     * 否则一个只恢复文件、结果照样丢掉的半吊子实现也能蒙混过关。 */
    const snap = async () => await evalJS('(()=>{const s=GNSS_VIEW.batch.slots;' +
      'const f=s[1];return {' +
      'fixed:f.fixed&&f.fixed.name, nMany:f.many.length, nFixedFiles:f.files.fixed?1:0,' +
      'nManyFiles:f.files.many.length, nTasks:f.tasks.length, nRuns:f.runs.length,' +
      'means:f.runs.map(r=>+r.stats.mean.toFixed(6)),' +
      'mask:f.runs[0]&&f.runs[0].mask, m2Runs:s[2].runs.length}})()');
    const before = await snap();
    chk('切走前模式① 的现场有内容', before.nRuns > 0 && before.nTasks > 0, JSON.stringify(before).slice(0, 70));

    // 先切到模式② 再切回：多绕一跳，确保不是「第一次同步时顺手填的」
    await evalJS('document.querySelector(\'input[name="bmode"][value="1"]\').click()');
    await sleep(300);
    const at1 = await snap();
    chk('切到模式② 后模式① 的现场仍在内存中', at1.nRuns === before.nRuns && at1.nTasks === before.nTasks);

    await evalJS('document.querySelector(\'input[name="bmode"][value="2"]\').click()');
    await sleep(300);
    const at2 = await snap();
    chk('切到模式② 后模式② 现场完好', at2.m2Runs > 0, at2.m2Runs + ' 项');

    await evalJS('document.querySelector(\'input[name="bmode"][value="1"]\').click()');
    await sleep(300);
    const back = await snap();
    chk('切回模式① 后文件选择原样恢复',
        back.fixed === before.fixed && back.nMany === before.nMany &&
        back.nFixedFiles === before.nFixedFiles && back.nManyFiles === before.nManyFiles,
        back.fixed + ' / ' + back.nMany);
    chk('切回模式① 后任务表原样恢复', back.nTasks === before.nTasks, back.nTasks + '');
    chk('切回模式① 后仿真结果原样恢复', back.nRuns === before.nRuns, back.nRuns + '');
    chk('切回模式① 后每项结果逐位相同',
        JSON.stringify(back.means) === JSON.stringify(before.means),
        back.means.join(',') + ' vs ' + before.means.join(','));
    chk('切回模式① 后结果面板重新显示', await evalJS(
      'document.getElementById("bResPanel").style.display !== "none"'));
    /* input.files 无法程序化赋值：若不清空，浏览器自带的「2 个文件」会停在另一个
     * 模式那一份上，与我们自己写的标签「1 份」当场矛盾。克隆替换是唯一解法。 */
    chk('切模式后浏览器自带的文件名不留上一模式的残留',
        await evalJS('document.getElementById("bFixed").files.length===0 &&' +
                     'document.getElementById("bMany").files.length===0'));
    chk('切模式后 file input 的 accept 已随模式更新', await evalJS(
      'document.getElementById("bFixed").accept.indexOf(".csv")>=0 &&' +
      'document.getElementById("bMany").accept.indexOf(".rnx")>=0'),
      await evalJS('document.getElementById("bFixed").accept + " | " + document.getElementById("bMany").accept'));
    chk('清空原生 input 后仍能重新选文件', await evalJS(
      '(()=>{document.getElementById("bMany").dispatchEvent(new Event("change"));return true})()'));
    chk('切回模式① 后预览表重新渲染', await evalJS(
      'document.getElementById("bPrev").querySelectorAll("table.btab tr").length > 1'));
    chk('固定文件标签按模式① 回填为轨迹', await evalJS(
      'document.getElementById("bFixedName").textContent.includes("flight_shanghai_xian")'),
      await evalJS('document.getElementById("bFixedName").textContent'));
    chk('原生 input 已清空时标签注明「已保留」', await evalJS(
      'document.getElementById("bFixedName").textContent.includes("已保留") &&' +
      'document.getElementById("bManyName").textContent.includes("已保留")'),
      await evalJS('document.getElementById("bFixedName").textContent + " / " + document.getElementById("bManyName").textContent'));
    chk('结果标题标注了跑这批时的掩角', await evalJS(
      'document.getElementById("bResMeta").textContent.includes("掩角 " + GNSS_VIEW.batch.slots[1].runs[0].mask.toFixed(1))'),
      await evalJS('document.getElementById("bResMeta").textContent'));
    chk('结果标题标注了当前模式', await evalJS(
      'document.getElementById("bResMeta").textContent.includes("模式 ①")'));

    /* 两个 slot 必须真的各自独立。注意**不能**断言两边的均值不同：这套 fixture
     * 两个模式用的是同一份星历和同一条轨迹，均值本就应当相同，断言它不同是错的。
     * 该断言的是容器互为不同对象，且代理写入只落到当前 slot。 */
    const indep = await evalJS('(()=>{const s=GNSS_VIEW.batch.slots;' +
      'return {runs:s[1].runs!==s[2].runs, tasks:s[1].tasks!==s[2].tasks,' +
      'fixed:s[1].fixed!==s[2].fixed, many:s[1].many!==s[2].many,' +
      'files:s[1].files!==s[2].files}})()');
    chk('两个 slot 的容器互为不同对象',
        indep.runs && indep.tasks && indep.many && indep.files, JSON.stringify(indep));
    chk('两个 slot 的固定文件各不相干', indep.fixed);
    /* baseline 是数字，不能比身份，得比「写了会不会串」 */
    const bsw = await evalJS('(()=>{const B=GNSS_VIEW.batch,s=B.slots;' +
      'const o=[s[1].baseline,s[2].baseline];B.mode=1;B.baseline=1;' +
      'const after=[s[1].baseline,s[2].baseline];B.baseline=o[0];return {o,after}})()');
    chk('代理写入只落到当前 slot',
        bsw.after[0] === 1 && bsw.after[1] === bsw.o[1], JSON.stringify(bsw));
    const mut = await evalJS('(()=>{const B=GNSS_VIEW.batch,s=B.slots;' +
      'const n0=[s[1].runs.length,s[2].runs.length];' +
      'B.mode=1;B.runs.push({name:"probe"});const after=[s[1].runs.length,s[2].runs.length];' +
      'B.runs.pop();' +
      'return {n0,after,restored:s[1].runs.length===n0[0]&&s[2].runs.length===n0[1]}})()');
    chk('runs 的代理写入只落在模式① 上',
        mut.after[0] === mut.n0[0] + 1 && mut.after[1] === mut.n0[1] && mut.restored,
        JSON.stringify(mut));
    chk('模式① 的每项都是星历任务', await evalJS(
      'GNSS_VIEW.batch.slots[1].runs.every(r=>r.kind==="rinex")'));
    chk('模式② 的每项都是轨迹任务', await evalJS(
      'GNSS_VIEW.batch.slots[2].runs.every(r=>r.kind==="trace")'));

    // 参数在切换中保持
    await evalJS('(()=>{const m=document.getElementById("bMask");m.value=23;m.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await evalJS('document.querySelector(\'input[name="bmode"][value="2"]\').click()');
    await sleep(250);
    await evalJS('document.querySelector(\'input[name="bmode"][value="1"]\').click()');
    await sleep(250);
    chk('切模式不改变掩角设置', await evalJS('GNSS_VIEW.batch.mask') === 23);
    chk('切模式不改变结果面板的掩角标注', await evalJS(
      'document.getElementById("bResMeta").textContent.includes("掩角 0.0°")'),
      await evalJS('document.getElementById("bResMeta").textContent'));
    await evalJS('(()=>{const m=document.getElementById("bMask");m.value=0;m.dispatchEvent(new Event("input",{bubbles:true}))})()');

    // 起始时刻是共用控件：改了它两个 slot 的锚定都要跟上
    await evalJS('(()=>{const h=document.getElementById("bHms");h.value="06:30:00";h.dispatchEvent(new Event("change",{bubbles:true}))})()');
    await sleep(250);
    const t0 = await evalJS('(()=>{const s=GNSS_VIEW.batch.slots;' +
      'return [s[1].tasks[0]&&s[1].tasks[0].t0Gps, s[2].tasks[0]&&s[2].tasks[0].t0Gps]})()');
    chk('改起始时刻后模式① 的锚点同步更新', t0[0] !== null && t0[0] !== undefined &&
        String(t0[0]).slice(-5).replace(/\..*$/, '') !== '', String(t0[0]));
    chk('改起始时刻后模式② 的锚点同步更新', t0[1] !== null && t0[1] !== undefined);
    await evalJS('(()=>{const h=document.getElementById("bHms");h.value="00:00:00";h.dispatchEvent(new Event("change",{bubbles:true}))})()');
    await sleep(250);

    /* input.files 无法程序化赋值，切模式后浏览器自带的文件名仍停在另一模式那份。
     * 所以「切回来直接重跑，不重新选文件」必须成立 —— 否则用户会以为自己没选对。 */
    chk('切回后无需重选文件即可直接重跑', await evalJS(
      '!document.getElementById("bGo").disabled'));
    await evalJS('document.getElementById("bGo").click()');
    await sleep(150);
    /* 跑批期间换模式会把正在写入的结果落到另一个 slot，所以此时必须锁死 */
    const lockedDuring = await evalJS(
      'Array.from(document.getElementsByName("bmode")).every(r=>r.disabled)');
    let sawLock = lockedDuring;
    for (let i = 0; i < 400; i++) {
      await sleep(250);
      if (!(await evalJS('document.getElementById("bProg").classList.contains("on")'))) break;
      if (!sawLock) sawLock = await evalJS(
        'Array.from(document.getElementsByName("bmode")).every(r=>r.disabled)');
    }
    chk('跑批期间模式选择被锁死', sawLock);
    chk('跑完后模式选择恢复可用', await evalJS(
      'Array.from(document.getElementsByName("bmode")).every(r=>!r.disabled)'));
    const rerun = await evalJS('GNSS_VIEW.batch.runs.map(r=>+r.stats.mean.toFixed(6))');
    chk('不重选文件重跑得到同一批结果',
        JSON.stringify(rerun) === JSON.stringify(back.means), rerun.join(','));
  }

  console.log('\n=== 批量任务：星座 全选 / 全不选 ===');
  {
    /* 这两个按钮曾与单任务面板的同名按钮共用 id=bAll/bNone。getElementById 只认
     * 第一个，于是批量这两个监听器绑到了**单任务**的按钮上：批量面板的按钮点了
     * 完全没反应（用户报的现象），而点单任务的「全选」会顺手改掉批量的星座选择。 */
    const sysSize = async () => await evalJS('GNSS_VIEW.batch.sys.size');
    const chipsOn = async () => await evalJS(
      'document.querySelectorAll("#bChips .chip.on").length');
    const singleSize = async () => await evalJS('GNSS_VIEW.state.sys.size');

    await evalJS('document.getElementById("bAllSys").click()');
    await sleep(150);
    chk('批量「全选」勾上全部 7 个星座', await sysSize() === 7, await sysSize() + '');
    chk('批量「全选」重绘 chips 为全亮', await chipsOn() === 7, await chipsOn() + '');

    await evalJS('document.getElementById("bNoneSys").click()');
    await sleep(150);
    chk('批量「全不选」清空星座', await sysSize() === 0, await sysSize() + '');
    chk('批量「全不选」重绘 chips 为全灭', await chipsOn() === 0, await chipsOn() + '');
    chk('一个星座都不选时禁用「开始批量仿真」', await evalJS(
      'document.getElementById("bGo").disabled'));
    chk('全不选不影响单任务的星座选择', await singleSize() === 7, await singleSize() + '');

    // 点单任务的「全选」不得反过来动批量的选择 —— 这是同一个 id 造成的串味
    await evalJS('document.getElementById("bAll").click()');
    await sleep(250);
    chk('点单任务「全选」不改变批量的星座选择', await sysSize() === 0, await sysSize() + '');
    await evalJS('document.querySelector(\'input[name="bmode"][value="1"]\').click()');
    await sleep(200);
    chk('切到模式① 后批量星座选择仍是全不选', await sysSize() === 0, await sysSize() + '');

    // 逐个点 chip 也要能恢复，并重新启用开始按钮
    await evalJS('document.querySelectorAll("#bChips .chip")[0].click()');
    await sleep(150);
    chk('点单个 chip 可重新勾选', await sysSize() === 1, await sysSize() + '');
    chk('只勾一个星座时「开始批量仿真」恢复可用', await evalJS(
      '!document.getElementById("bGo").disabled'));
    await evalJS('document.getElementById("bAllSys").click()');
    await sleep(150);
    chk('恢复为全选', await sysSize() === 7, await sysSize() + '');

    // 单任务那一组（bAll / bNone / bG / bC）之前被批量抢走了绑定，一并验一遍
    await evalJS('document.getElementById("bG").click()');
    await sleep(300);
    chk('单任务「仅 GPS」生效', await singleSize() === 1 && await evalJS(
      'GNSS_VIEW.state.sys.has("G")'), await singleSize() + '');
    await evalJS('document.getElementById("bC").click()');
    await sleep(300);
    chk('单任务「仅北斗」生效', await singleSize() === 1 && await evalJS(
      'GNSS_VIEW.state.sys.has("C")'), await singleSize() + '');
    chk('单任务「仅 GPS/仅北斗」同步了 #syslist 的勾选框', await evalJS(
      'Array.from(document.querySelectorAll("#syslist input")).filter(i=>i.checked).length===1'));
    await evalJS('document.getElementById("bAll").click()');
    await sleep(300);
    chk('单任务「全选」恢复 7 个星座', await singleSize() === 7, await singleSize() + '');
  }

  console.log('\n=== 批量任务：单任务界面未被污染 ===');
  {
    chk('单任务状态仍完好', await evalJS(
      'GNSS_VIEW.state.counts.length === 5000 && !document.getElementById("bRun").disabled'));
    chk('关闭浮层后单任务图表仍可重绘',
        await evalJS('(()=>{GNSS_VIEW.recompute();return true})()'));
    await evalJS('document.getElementById("bClose").click()');
    chk('浮层已关闭', !(await evalJS('document.getElementById("batch").classList.contains("on")')));
  }

  chk('全流程无任何 JS 异常', errs.length === 0, errs.slice(0, 5).join(' | '));

  ws.close(); proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome 尚未完全退出 */ }
  console.log('\n' + (fails ? '*** ' + fails + ' 项失败 ***' : '浏览器端到端全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
