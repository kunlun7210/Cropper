const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../frame-detector.js');
const fs = require('node:fs');
const vm = require('node:vm');
function sample(ui = true, texture = true) {
  const width = 400, height = 880, pixels = new Uint8ClampedArray(width * height * 4);
  const rect = (x0,y0,x1,y1,rgb) => { for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) pixels.set([...rgb,255],(y*width+x)*4); };
  rect(0,0,width,height,[65,85,105]);
  rect(0,295,width,585,[190,200,210]);
  if(texture) for(let y=298;y<582;y++)for(let x=0;x<width;x++) { const k=(Math.floor(x/7)+Math.floor(y/7))%2; pixels.set(k?[120,145,170,255]:[200,220,240,255],(y*width+x)*4); }
  if(ui) {
    for(let x=50;x<95;x+=7)rect(x,26,x+3,38,[0,0,0]);
    for(let x=288;x<356;x+=7)rect(x,26,x+3,38,[0,0,0]);
    for(let x=70;x<350;x+=7)rect(x,67,x+3,81,[245,245,245]);
  }
  return {width,height,pixels};
}
test('彩色留白需状态栏、导航与清晰照片双边界共同确认',()=> {
  const found=F.analyze(sample());assert.ok(found);assert.ok(Math.abs(found.photo.top-295)<=3);assert.ok(Math.abs(found.photo.bottom-585)<=3);
});
test('普通彩色横带、无界面照片、全纯色不按背景裁剪',()=> {
  assert.equal(F.analyze(sample(false)),null);assert.equal(F.analyze(sample(true,false)),null);
  const s=sample();s.pixels.fill(80);assert.equal(F.analyze(s),null);
});
test('状态栏连续照片纹理不能冒充局部文字',()=> {
  const s=sample();for(let y=0;y<60;y++)for(let x=0;x<s.width;x++)s.pixels.set((x%5)?[200,210,220,255]:[0,0,0,255],(y*s.width+x)*4);
  assert.equal(F.analyze(s),null);
});
test('内部亮横线不能把主体截成多段',()=> {
  const s=sample();for(let y=420;y<428;y++)for(let x=0;x<s.width;x++)s.pixels.set([250,250,250,255],(y*s.width+x)*4);
  const found=F.analyze(s);assert.ok(found);assert.ok(found.photo.top<300&&found.photo.bottom>580);
});
test('没有右侧文字的紧凑导航栏需同时有状态栏、两个控件和黑色底边', () => {
  function compactViewer({ status = true, counter = true, footer = true } = {}) {
    const s = sample(false);
    const { width, height, pixels } = s;
    const rect = (x0, y0, x1, y1, level) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        pixels.set([level, level, level, 255], (y * width + x) * 4);
      }
    };
    rect(0, 0, width, 107, 48);
    rect(0, 107, width, height, 170);
    if (footer) rect(0, 800, width, height, 0);
    if (status) {
      for (let x = 50; x < 95; x += 7) rect(x, 26, x + 3, 38, 0);
      for (let x = 288; x < 356; x += 7) rect(x, 26, x + 3, 38, 0);
    }
    for (let y = 75; y < 94; y++) {
      const x = 24 + Math.abs(y - 84);
      rect(x, y, x + 3, y + 1, 250);
    }
    if (counter) for (let x = 190; x < 210; x += 6) rect(x, 78, x + 4, 92, 250);
    return s;
  }
  const frame = F.analyze(compactViewer());
  assert.equal(frame?.kind, 'viewer-toolbar');
  assert.ok(Math.abs(frame.photo.top - 107) <= 2);
  assert.ok(Math.abs(frame.photo.bottom - 800) <= 2);
  for (const signal of ['status', 'counter', 'footer']) {
    assert.equal(F.analyze(compactViewer({ [signal]: false })), null, signal);
  }
});
test('新照片原始边界换算后模板仍按整数采样行扫描',()=> {
  const calls = [], scope = { ViewerMarks: { find: (...args) => calls.push(args) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../viewer-detector.js'), 'utf8'), scope);
  const profile = { width: 460, height: 1000 };
  scope.ViewerDetector.findMarks(profile, 653.3180778032037);
  assert.equal(calls[0][0], profile);
  assert.equal(calls[0][1], 653);
});
