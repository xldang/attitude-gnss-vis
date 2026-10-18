/* 截图 + 画布诊断：载入样本、跑仿真、抓页面截图与两张画布的统计信息。
 *   node test/tools/shot.js [outfile.png]
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
const OUT = process.argv[2] || path.join(ROOT, 'build', 'shot.png');
const PORT = 9345;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--allow-file-access-from-files', '--window-size=1600,1400', 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = l.find(t => t.type === 'page');
    } catch (e) {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evalJS = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result.result.value;
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: HTML });
  await sleep(1500);
  const doc = await send('DOM.getDocument', { depth: -1 });
  for (const [sel, f] of [['#fRnx', RNX], ['#fCsv', CSV]]) {
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: sel });
    await send('DOM.setFileInputFiles', { files: [f], nodeId: q.result.nodeId });
    await sleep(400);
  }
  await evalJS('document.getElementById("bRun").click()');
  for (let i = 0; i < 200; i++) { await sleep(250); if (!(await evalJS('document.getElementById("bExp").disabled'))) break; }
  await sleep(600);

  // node shot.js out.png [元素 id | 0~1 的悬停比例 [元素 id]]  —— 指定后把鼠标悬停到图①上并只截该元素
  const focus = process.argv[3] || null;
  // 第三个参数若是数字，则当作「悬停到该比例处的历元」而不是元素 id
  const frac = (focus && /^\d*\.?\d+$/.test(focus)) ? parseFloat(focus) : null;
  const focusEl = frac === null ? focus : (process.argv[4] || 'c3');
  let clip = null;
  if (focus) {
    const f = frac === null ? 0.5 : frac;
    await evalJS(`(()=>{const c=document.getElementById('c1');const r=c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+58+(r.width-74)*${f},
        clientY:r.top+120,bubbles:true}));return 1})()`);
    await sleep(400);
    clip = await evalJS(`(()=>{const e=document.getElementById(${JSON.stringify(focusEl)});
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
    await sleep(300);
    // CDP 的 clip 用的是**页面坐标**（文档原点），不是视口坐标，要加上滚动量
    const r2 = await evalJS(`(()=>{const r=document.getElementById(${JSON.stringify(focusEl)})
      .getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,
        height:r.height,scale:1}})()`);
    clip = r2;
  }

  const shot = await send('Page.captureScreenshot',
      clip ? { format: 'png', captureBeyondViewport: true, clip } : { format: 'png' });
  if (shot.error) { console.error('截图失败:', JSON.stringify(shot.error)); process.exit(1); }
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('截图 ->', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');

  // 两张画布的尺寸 / CSS 尺寸 / 布局位置 / 实际数据范围
  console.log('\n画布诊断:');
  console.log(JSON.stringify(await evalJS(`(()=>{
    const o={};
    for (const id of ['c1','c2']) {
      const c=document.getElementById(id), r=c.getBoundingClientRect();
      const st=getComputedStyle(c);
      o[id]={attrW:c.width, attrH:c.height,
             cssW:Math.round(r.width), cssH:Math.round(r.height),
             x:Math.round(r.x), y:Math.round(r.y),
             styleW:st.width, styleH:st.height, display:st.display};
    }
    o.data={cntMin:Math.min(...GNSS_VIEW.state.counts), cntMax:Math.max(...GNSS_VIEW.state.counts),
            pdMin:Math.min(...GNSS_VIEW.state.pdops), pdMax:Math.max(...GNSS_VIEW.state.pdops),
            pdMed:[...GNSS_VIEW.state.pdops].sort((a,b)=>a-b)[2500]};
    o.view={xa:GNSS_VIEW.drawAll?undefined:undefined};
    return o;})()`), null, 1));

  // 逐行统计每张画布的非透明像素，看曲线落在哪
  console.log('\n每 20 行扫描的非透明像素分布（判断曲线是否画在画布内）:');
  console.log(await evalJS(`(()=>{let out=[];
    for(const id of ['c1','c2']){const c=document.getElementById(id);
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const rows=[];for(let y=0;y<c.height;y+=Math.floor(c.height/12)){let n=0;
        for(let x=0;x<c.width;x++) if(d[(y*c.width+x)*4+3]>0) n++; rows.push(y+':'+n);}
      out.push(id+' '+rows.join(' '));}
    return out.join('\\n')})()`));

  ws.close(); proc.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
