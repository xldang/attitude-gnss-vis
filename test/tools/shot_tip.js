/* 悬停某个 "?" 图标后截图，用来检查说明气泡的排版与是否被裁掉。
 *   node test/tools/shot_tip.js out.png "<css 选择器>" [元素id]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.join(__dirname, '..', '..');
const HTML = 'file:///' + path.join(ROOT, 'gnss_pdop_tool.html').replace(/\\/g, '/');
const RNX = path.join(ROOT, 'samples', 'rnx', 'BRDM00DLR_S_20262690000_01D_MN.rnx');
const CSV = path.join(ROOT, 'samples', 'traces', 'flight_shanghai_xian_5000.csv');
const OUT = process.argv[2] || path.join(ROOT, 'build', 'tip.png');
const SEL = process.argv[3] || 'h2 .q';
const ELEM = process.argv[4] || '0';
const PORT = 9800 + (process.pid % 150);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--allow-file-access-from-files', '--window-size=1700,1400', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try { target = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find(t => t.type === 'page'); } catch (e) {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const evalJS = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: HTML });
  await sleep(1200);
  const doc = await send('DOM.getDocument', { depth: -1 });
  for (const [sel, f] of [['#fRnx', RNX], ['#fCsv', CSV]]) {
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: sel });
    await send('DOM.setFileInputFiles', { files: [f], nodeId: q.result.nodeId });
    await sleep(350);
  }
  await evalJS('document.getElementById("bRun").click()');
  for (let i = 0; i < 200; i++) { await sleep(250); if (!(await evalJS('document.getElementById("bExp").disabled'))) break; }
  await sleep(500);

  // 把鼠标真的移到第 N 个匹配的 "?" 上，触发 :hover
  const box = await evalJS(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(SEL)})];
    if(!els.length) return null; const i=Math.min(${ELEM}|0, els.length-1);
    const r=els[i].getBoundingClientRect();
    return {x:r.x+r.width/2, y:r.y+r.height/2, n:els.length};})()`);
  if (!box) throw new Error('选择器没匹配到元素: ' + SEL);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await sleep(400);

  const clip = await evalJS(`(()=>{const e=document.getElementById(${JSON.stringify(ELEM === '0' ? 'body' : ELEM)});
    if(!e) return null; const r=e.getBoundingClientRect();
    return {x:Math.max(0,r.x+scrollX-14), y:Math.max(0,r.y+scrollY-14),
            width:r.width+28, height:r.height+28, scale:1};})()`);
  const shot = await send('Page.captureScreenshot',
    { format: 'png', clip: clip || undefined, captureBeyondViewport: !!clip });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(`截图 -> ${OUT}（悬停 ${SEL}[${ELEM}]，共 ${box.n} 个，x=${box.x.toFixed(0)} y=${box.y.toFixed(0)}）`);

  ws.close(); proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
