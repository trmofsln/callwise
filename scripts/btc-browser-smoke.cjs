/* eslint-disable @typescript-eslint/no-require-imports -- Local isolated Chromium QA; no real browser profile. */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const base=process.argv[2]||'http://localhost:3102';
const port=19329;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main() {
  let browser,socket,send;const report={home:null,desktop:null,mobile:null,admin:null,console_errors:[]};
  try {
    let occupied=false;try{const r=await fetch(`http://localhost:${port}/json/version`,{signal:AbortSignal.timeout(500)});occupied=r.ok;}catch{}
    if(occupied)throw Error('QA debugging port occupied; refusing to attach to another browser.');
    const executable='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profile=path.resolve('.data/btc-browser');
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--window-size=1400,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
    let targets;
    for(let i=0;i<40;i++){try{targets=await fetch(`http://localhost:${port}/json/list`).then(r=>r.json());if(targets.length)break;}catch{}await delay(250);}
    assert.ok(targets?.[0]?.webSocketDebuggerUrl,'Isolated Chrome did not start.');
    socket=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();
    socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const callback=pending.get(m.id);pending.delete(m.id);if(m.error)callback?.reject(Error(m.error.message));else callback?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')report.console_errors.push(m.params.exceptionDetails.text);};
    send=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});socket.send(JSON.stringify({id:current,method,params}));});
    const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
    await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base});
    for(let i=0;i<60;i++){if(await evaluate("Object.keys(document.getElementById('glids')||{}).some(key=>key.startsWith('__reactFiber'))"))break;await delay(100);}
    await evaluate('document.fonts.ready');await delay(200);
    report.home={title:await evaluate('document.title'),input_labelled:await evaluate("!!document.querySelector('label[for=glids]')"),no_horizontal_overflow:await evaluate('document.documentElement.scrollWidth<=1400')};
    const homeLayout=await send('Page.getLayoutMetrics');
    const home=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1400,height:Math.min(1800,homeLayout.cssContentSize.height),scale:1}});fs.writeFileSync('.data/best-time-to-call/home-desktop.png',Buffer.from(home.data,'base64'));
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(200);
    report.home.mobile_no_horizontal_overflow=await evaluate('document.documentElement.scrollWidth<=390');
    const homeMobile=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.data/best-time-to-call/home-mobile.png',Buffer.from(homeMobile.data,'base64'));
    await send('Emulation.clearDeviceMetricsOverride');await delay(100);
    const first=fs.readdirSync('.data/user-lookups').filter(f=>f.endsWith('.json')).sort()[0];
    const glid=process.env.BTC_SAMPLE_GLID||JSON.parse(fs.readFileSync(`.data/user-lookups/${first}`,'utf8')).requestedGlids[0];
    await evaluate("document.getElementById('glids').focus()");
    await send('Input.insertText',{text:glid});
    await delay(200);await evaluate("document.querySelector('form button[type=submit]').click()");
    for(let i=0;i<120;i++){if(await evaluate("!!document.querySelector('.queue-row-open')"))break;await delay(250);}
    await evaluate("document.querySelector('.queue-row-open')?.click()");
    for(let i=0;i<40;i++){if(await evaluate("!!document.querySelector('.call-recommendation')"))break;await delay(250);}
    if(!await evaluate("!!document.querySelector('.call-recommendation')")) {
      const screenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.data/best-time-to-call/demo-failure.png',Buffer.from(screenshot.data,'base64'));
      console.log(JSON.stringify({submit_disabled:await evaluate("document.querySelector('form button[type=submit]').disabled"),alert:await evaluate("document.querySelector('[role=alert]')?.textContent||null"),console_errors:report.console_errors}));
      throw Error('Recommendation UI did not render after real lookup.');
    }
    report.desktop={recommendation_rendered:true,scoring_model:await evaluate("document.querySelector('.scoring-model-name strong')?.textContent||null"),model_kind:await evaluate("document.querySelector('.scoring-model-name .tag')?.textContent||null"),top_score:await evaluate("document.querySelector('.model-top-score strong')?.textContent||null"),slot_scores:await evaluate("[...document.querySelectorAll('.slot-score-value')].map(s=>s.textContent)"),ranked_rows:await evaluate("document.querySelector('.call-recommendation tbody').rows.length"),overall_tables:await evaluate("document.querySelectorAll('.overall-calling-plan table').length"),daily_groups:await evaluate("document.querySelectorAll('.calling-day').length"),retry_time:await evaluate("document.querySelector('.retry-preview strong').textContent"),best_time:await evaluate("document.querySelector('.call-next strong').textContent"),retry_delay:await evaluate("document.querySelector('.retry-delay')?.textContent||null"),ranks:await evaluate("[...document.querySelectorAll('.overall-calling-plan .slot-rank')].map(s=>Number(s.textContent))"),has_suggestion:await evaluate("!document.querySelector('.call-next strong').textContent.includes('No eligible window')"),no_horizontal_overflow:await evaluate('document.documentElement.scrollWidth<=window.innerWidth')};
    await evaluate("document.querySelector('.call-recommendation').scrollIntoView({block:'start'})");
    const desktop=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.data/best-time-to-call/demo-desktop.png',Buffer.from(desktop.data,'base64'));
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(100);
    await evaluate("document.querySelector('.call-recommendation').scrollIntoView({block:'start'})");
    report.mobile={no_horizontal_overflow:await evaluate('document.documentElement.scrollWidth<=390'),viewport_width:await evaluate('window.innerWidth'),recommendation_rendered:await evaluate("!!document.querySelector('.call-recommendation')")};
    const mobile=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.data/best-time-to-call/demo-mobile.png',Buffer.from(mobile.data,'base64'));
    const planRect=await evaluate("(()=>{const r=document.querySelector('.call-recommendation').getBoundingClientRect();return {y:r.top+scrollY,height:r.height};})()");
    const fullPlan=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:planRect.y,width:390,height:planRect.height,scale:1}});fs.writeFileSync('.data/best-time-to-call/demo-mobile-plan.png',Buffer.from(fullPlan.data,'base64'));
    assert.ok(report.desktop.scoring_model);assert.ok(report.desktop.top_score);assert.equal(report.desktop.slot_scores.length,report.desktop.ranked_rows);assert.ok(report.desktop.ranked_rows>=1&&report.desktop.ranked_rows<=4);assert.equal(report.desktop.overall_tables,1);assert.equal(report.desktop.daily_groups,0);assert.notEqual(report.desktop.retry_time,report.desktop.best_time);assert.ok(report.desktop.retry_delay?.includes('Wait '));assert.deepEqual(report.desktop.ranks,Array.from({length:report.desktop.ranked_rows},(_,i)=>i+1));assert.equal(report.desktop.has_suggestion,true);assert.equal(report.desktop.no_horizontal_overflow,true);assert.equal(report.home.no_horizontal_overflow,true);assert.equal(report.home.mobile_no_horizontal_overflow,true);assert.equal(report.mobile.no_horizontal_overflow,true);assert.equal(report.mobile.viewport_width,390);assert.deepEqual(report.console_errors,[]);
    if(process.env.BTC_QA_ADMIN_COOKIE) {
      const split=process.env.BTC_QA_ADMIN_COOKIE.indexOf('=');
      await send('Network.enable');await send('Network.setCookie',{name:process.env.BTC_QA_ADMIN_COOKIE.slice(0,split),value:process.env.BTC_QA_ADMIN_COOKIE.slice(split+1),url:base,httpOnly:true,sameSite:'Strict'});
      await send('Emulation.clearDeviceMetricsOverride');await send('Page.navigate',{url:`${base}/admin`});
      for(let i=0;i<100;i++){if(await evaluate("!!document.querySelector('.experiment-model')"))break;await delay(150);}
      report.admin={report_rendered:await evaluate("!!document.querySelector('.experiment-model')"),no_horizontal_overflow:await evaluate('document.documentElement.scrollWidth<=1400')};
      assert.equal(report.admin.report_rendered,true);assert.equal(report.admin.no_horizontal_overflow,true);
      await evaluate("document.querySelector('.experiment-report').scrollIntoView({block:'start'})");await delay(100);
      const admin=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('.data/best-time-to-call/admin-experiment.png',Buffer.from(admin.data,'base64'));
    }
    fs.writeFileSync('.data/best-time-to-call/browser-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {if(socket?.readyState===WebSocket.OPEN&&send){try{await Promise.race([send('Browser.close'),delay(1000)]);}catch{}}socket?.close();browser?.kill();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
