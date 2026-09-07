// Run with Playwright installed: node tests/browser-check.cjs
// Uses an isolated headless Chrome profile and a loopback-only HTTP server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
let browser, server;
async function main() {
  server = http.createServer(async (req,res) => {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname==='/'?'/index.html':pathname));
    if (!file.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
    try {res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));}
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:402,height:874},acceptDownloads:true});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  assert.equal(await page.locator('#batchActions').isVisible(),false);
  assert.equal(await page.locator('.settings-panel').getAttribute('open'),null);
  const fixtures=await page.evaluate(()=>{
    const result={};
    for(const name of ['border','stripe','white','black','thin']){
      const c=document.createElement('canvas');c.width=200;c.height=160;
      const g=c.getContext('2d');g.fillStyle=name==='black'?'black':'white';g.fillRect(0,0,200,160);
      if(name==='border'){g.fillStyle='black';g.fillRect(0,0,200,160);for(let y=20;y<140;y++)for(let x=20;x<180;x++){g.fillStyle=`rgb(255,${y},${x})`;g.fillRect(x,y,1,1);}}
      if(name==='stripe'){g.fillStyle='black';g.fillRect(0,20,200,20);}
      if(name==='thin'){g.fillStyle='black';g.fillRect(0,0,200,1);}
      result[name]=c.toDataURL().split(',')[1];
    }return result;
  });
  await page.locator('.settings-summary').click();
  const slider=page.locator('#padding');
  async function adjust(value){
    await slider.press('Home');
    for(let i=-5;i<value;i++)await slider.press('ArrowRight');
    assert.equal(await slider.inputValue(),String(value));
  }
  async function upload(name){
    await page.locator('#fileInput').setInputFiles({name:name+'.png',mimeType:'image/png',buffer:Buffer.from(fixtures[name],'base64')});
    await page.locator('.result-card h3').filter({hasText:name+'.png'}).waitFor();
  }
  async function output(width,height){
    await page.waitForFunction(([w,h])=>{const i=document.querySelector('.result-image');return i?.complete&&i.naturalWidth===w&&i.naturalHeight===h},[width,height]);
    assert.match(await page.locator('.result-head').innerText(),new RegExp(`输出 ${width} × ${height}px`));
  }
  await adjust(-5);await upload('border');await output(150,110);
  assert.match(await page.locator('.actual-crop').innerText(),/上 25px · 下 25px · 左 25px · 右 25px/);
  console.log('PASS select -5 before importing: real image output 150x110');
  for(const [n,w,h] of [[0,160,120],[-1,158,118],[3,166,126],[-5,150,110]]){await adjust(n);await output(w,h);}
  console.log('PASS slider automatically updates existing image at 0/-1/+3/-5');
  await page.getByRole('button',{name:'恢复默认',exact:true}).click();await output(160,120);
  await page.locator('.fine-tune summary').click();
  await page.locator('[data-side-input="top"]').fill('30');
  await page.locator('.hero h1').click();await output(160,110);
  assert.equal(await page.locator('[data-side-input="top"]').inputValue(),'30');
  await page.getByRole('button',{name:'重新裁剪',exact:true}).click();await output(160,110);
  const downloads=await fs.mkdtemp(path.join(os.tmpdir(),'cropper-browser-check-'));
  async function save(name,w,h){
    const ready=page.waitForEvent('download');await page.getByRole('button',{name:'下载图片',exact:true}).click();
    const download=await ready;const file=path.join(downloads,name);await download.saveAs(file);
    const data=await fs.readFile(file);assert.equal(data.readUInt32BE(16),w);assert.equal(data.readUInt32BE(20),h);
    const offsets=await page.locator('[data-side-input]').evaluateAll(inputs=>Object.fromEntries(inputs.map(el=>[el.dataset.sideInput,Number(el.value)])));
    const pixelsMatch=await page.evaluate(async({actual,original,offsets,w,h})=>{
      async function decode(src){const i=new Image();i.src=src;await i.decode();const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const g=c.getContext('2d');g.drawImage(i,0,0);return g;}
      const a=(await decode('data:image/png;base64,'+actual)).getImageData(0,0,w,h).data;
      const b=(await decode('data:image/png;base64,'+original)).getImageData(offsets.left,offsets.top,w,h).data;
      return a.every((v,i)=>v===b[i]);
    },{actual:data.toString('base64'),original:fixtures.border,offsets,w,h});
    assert.equal(pixelsMatch,true,'downloaded pixels match the exact source crop');
  }
  await save('manual.png',160,110);
  console.log('PASS manual top 30 persists through recrop and actual PNG download');
  for(const [side,value,w,h] of [['bottom',35,160,95],['left',31,149,95],['right',29,140,95]]){
    await page.locator('.fine-tune summary').click();
    await page.locator(`[data-side-input="${side}"]`).fill(String(value));
    await page.locator('.hero h1').click();await output(w,h);await save(`manual-${side}.png`,w,h);
  }
  console.log('PASS all four manual directions; every downloaded pixel matches source crop');
  // Reproduce a save while the last slider input has not emitted change yet.
  await page.locator('#padding').evaluate(el=>{el.value='-5';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await save('latest-settings.png',150,110);await output(150,110);
  console.log('PASS save applies pending slider input before generating PNG');
  await page.locator('.side-toggle[data-side="left"]').uncheck();
  await page.locator('.side-toggle[data-side="right"]').uncheck();await output(200,110);
  await upload('border');await output(200,110);
  console.log('PASS disabled sides remain untouched including new import');
  await page.getByRole('button',{name:'恢复默认',exact:true}).click();await adjust(-5);
  for(const name of ['stripe','white','black','thin']){await upload(name);await output(200,160);}
  console.log('PASS internal stripe, no border, pure black and undetected thin edge remain intact');
  for(const viewport of [{width:402,height:874},{width:874,height:402},{width:1200,height:900}]){
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.setViewportSize({width:402,height:874});await upload('border');await output(150,110);
  await page.screenshot({path:path.join(downloads,'mobile.png'),fullPage:true});
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();await page.locator('.hero h1').waitFor();
  await context.setOffline(true);await page.reload();await page.locator('.hero h1').waitFor();
  assert.equal(await page.locator('#padding').getAttribute('min'),'-5');
  assert.deepEqual(errors,[]);
  console.log('PASS mobile portrait/landscape, desktop and cached offline reload; no page errors');
  console.log('Evidence:',downloads);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.close();});
