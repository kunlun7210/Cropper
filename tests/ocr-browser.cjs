// Real PP-OCRv6 inference, local-only resources, corner/negative cases and warm offline use.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const dest = process.argv[2] || '/Users/kunlun/Codex/2026-08-17/ios-cropper/outputs/verify-v16-ocr';
const samples = '/Users/kunlun/Downloads/裁剪黑边测试图/新版测试图';
let browser, server;
async function main() {
  await fs.mkdir(dest, { recursive: true });
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  server = http.createServer(async (req, res) => {
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try { res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, acceptDownloads: true });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(requests.some(r => r.url.includes('/ocr/')), false);
  assert.equal(await page.locator('#ocrCorners').isChecked(), false);
  console.log('PASS default startup does not request OCR/models');
  const core = await page.evaluate(async () => {
    const engine = await CornerOCR.create();
    const make = () => {
      const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
      const g = c.getContext('2d');
      g.fillStyle = '#384556'; g.fillRect(0, 0, 1200, 900);
      return { c, g };
    };
    const draw = (g, text, corner) => {
      g.fillStyle = 'white'; g.font = '30px Arial';
      const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
      const tw = g.measureText(text).width, x = right ? 1170 - tw : 80, y = bottom ? 870 : 55;
      g.fillText(text, x, y); g.beginPath(); g.arc(x - 35, y - 15, 24, 0, Math.PI * 2); g.fill();
    };
    const photo = { left: 0, top: 0, right: 1200, bottom: 900 }, results = [];
    try {
      for (const text of ['高德地图', '百度地图', '腾讯地图', '艺龙', '携程', '同程旅行', '大众点评', '美团', '飞猪', '去哪儿', '淘宝']) {
        const { c, g } = make(); draw(g, text, 'bottom-right');
        results.push({ text, scan: await engine.scan(c, photo) });
      }
      const multi = make();
      for (const [text, corner] of [['携程', 'top-left'], ['同程', 'top-right'], ['大众点评', 'bottom-left'], ['美团', 'bottom-right']]) draw(multi.g, text, corner);
      const combined = await engine.scan(multi.c, photo);
      const negative = make();
      negative.g.fillStyle = 'white'; negative.g.font = '30px Arial';
      negative.g.fillText('美团外卖欢迎光临', 860, 870);
      negative.g.fillText('携程', 550, 460);
      negative.g.fillText('Baid地图', 35, 870); // approximate text without a real full logo must not pass
      negative.g.fillRect(1120, 20, 40, 40); // a logo without readable brand text is not guessed
      const clean = await engine.scan(negative.c, photo);
      const official = [];
      for (const brand of CornerDetector.brands) {
        const img = new Image(); img.src = `brand-assets/logos/${brand.id}.png`; await img.decode();
        for (const variant of ['color', 'white-smaller']) {
          const { c, g } = make();
          const width = variant === 'color' ? 140 : 110, height = img.naturalHeight * width / img.naturalWidth, top = 880 - height;
          let source = img;
          if (variant === 'white-smaller') {
            const mono = document.createElement('canvas'); mono.width = img.naturalWidth; mono.height = img.naturalHeight;
            const mg = mono.getContext('2d'); mg.drawImage(img, 0, 0);
            mg.globalCompositeOperation = 'source-in'; mg.fillStyle = 'white'; mg.fillRect(0, 0, mono.width, mono.height); source = mono;
          }
          g.drawImage(source, 1170 - width, top, width, height);
          official.push({ brand: brand.id, name: brand.name, variant, top, scan: await engine.scan(c, photo) });
        }
      }
      return { results, combined, clean, official };
    } finally { await engine.dispose(); }
  });
  await fs.writeFile(path.join(dest, 'ocr-cases.json'), JSON.stringify(core, null, 2));
  for (const { text, scan } of core.results) {
    assert.equal(scan.observations.length, 4);
    assert.ok(scan.marks.length >= 1, `${text} was not recognized: ${JSON.stringify(scan.observations)}`);
    assert.ok(scan.marks[0].y < 831, `${text} logo top must be removed too`);
  }
  assert.equal(core.combined.marks.length, 4);
  assert.equal(core.clean.marks.length, 0);
  console.log('PASS eleven brand names, four corners, nearby logos, prose/center/unknown-logo negatives');
  for (const sample of core.official) {
    console.log('OFFICIAL', sample.name, sample.variant, JSON.stringify({ top: sample.top, marks: sample.scan.marks }));
    assert.ok(sample.scan.marks.some(mark => mark.kind === sample.brand && mark.y <= sample.top + 1), `${sample.name} ${sample.variant} complete logo not covered: ${JSON.stringify(sample.scan.observations.flatMap(o => o.texts))}`);
  }

  const two = await sharp({ create: { width: 200, height: 160, channels: 3, background: '#326fb5' } }).png().toBuffer();
  await page.locator('#fileInput').setInputFiles(['A.png', 'B.png'].map(name => ({ name, mimeType: 'image/png', buffer: two })));
  await page.waitForFunction(() => state.items.length === 2);
  await page.locator('.result-card').first().locator('.fine-tune summary').click();
  await page.locator('.result-card').first().locator('[data-side-input="top"]').fill('5');
  await page.locator('.result-card').first().locator('[data-side-input="top"]').press('Tab');
  assert.deepEqual(await page.locator('.result-card h3').allTextContents(), ['A.png', 'B.png']);
  assert.deepEqual(await page.evaluate(() => state.items.map((item, i) => outputName(item, i))), ['001-A-trimmed.png', '002-B-trimmed.png']);
  console.log('PASS manual edits preserve card/export order');
  const base = await fs.readFile(path.join(samples, 'IMG_8932.PNG'));
  const heart = await sharp(path.join(samples, 'IMG_1020.PNG')).extract({ left: 1006, top: 2066, width: 60, height: 55 }).png().toBuffer();
  const multi = await sharp(base).composite([{ input: heart, left: 1006, top: 1580 }]).png().toBuffer();
  await page.locator('#fileInput').setInputFiles({ name: 'two-hearts.png', mimeType: 'image/png', buffer: multi });
  await page.waitForFunction(() => state.items[0]?.file.name === 'two-hearts.png');
  const twoHearts = await page.evaluate(() => ({ end: state.items[0].image.naturalHeight - state.items[0].values.bottom, values: state.items[0].values }));
  assert.ok(twoHearts.end <= 1580, JSON.stringify(twoHearts));
  console.log('PASS higher heart + lower heart + AMAP uses uppermost boundary');

  // UI integration, actual output and asynchronous manual-edit preservation.
  const fixture = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 1000;
    const g = c.getContext('2d'); g.fillStyle = 'black'; g.fillRect(0, 0, 1200, 1000);
    g.fillStyle = '#384556'; g.fillRect(0, 50, 1200, 900);
    g.fillStyle = 'white'; g.font = '30px Arial'; g.fillText('携程', 1100, 920);
    g.beginPath(); g.arc(1065, 905, 25, 0, Math.PI * 2); g.fill();
    return c.toDataURL().split(',')[1];
  });
  await page.locator('.settings-panel').evaluate(el => el.open = true);
  await page.locator('#fileInput').setInputFiles({ name: 'ctrip.png', mimeType: 'image/png', buffer: Buffer.from(fixture, 'base64') });
  await page.waitForFunction(() => state.items[0]?.file.name === 'ctrip.png');
  await page.locator('#ocrCorners').check();
  await page.evaluate(() => state.pending);
  assert.match(await page.locator('#ocrStatus').innerText(), /^四角增强识别完成/);
  const integrated = await page.evaluate(() => ({ values: state.items[0].values, photo: state.items[0].photo, marks: state.items[0].ocrMarks, observations: state.items[0].ocrCache.scan.observations }));
  assert.equal(integrated.values.top, 50);
  assert.ok(integrated.values.bottom > 115 && integrated.values.bottom < 160);
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载图片', exact: true }).click();
  await (await pendingDownload).saveAs(path.join(dest, 'ctrip-output.png'));
  const output = await sharp(path.join(dest, 'ctrip-output.png')).metadata();
  assert.equal(output.height, 1000 - integrated.values.top - integrated.values.bottom);
  console.log('PASS OCR UI result/export uses subject corners and removes adjacent logo');
  const cacheInfo = await page.evaluate(async () => ({ names: await caches.keys(), count: (await (await caches.open('cropper-ocr-v1')).keys()).length }));
  assert.ok(cacheInfo.count >= 9);
  await context.setOffline(true);
  await page.reload();
  await page.locator('.settings-panel').evaluate(el => el.open = true);
  await page.locator('#ocrCorners').check();
  await page.locator('#fileInput').setInputFiles({ name: 'offline-ctrip.png', mimeType: 'image/png', buffer: Buffer.from(fixture, 'base64') });
  await page.waitForFunction(() => state.items[0]?.file.name === 'offline-ctrip.png');
  await page.evaluate(() => state.pending);
  assert.match(await page.locator('#ocrStatus').innerText(), /^四角增强识别完成/);
  assert.ok(await page.evaluate(() => state.items[0].ocrMarks.length > 0));
  console.log('PASS cached OCR including worker/models runs after offline reload');
  await context.setOffline(false);
  const races = await page.evaluate(async () => {
    const realCreate = CornerOCR.create;
    let release, started;
    const waitStart = () => new Promise(resolve => started = resolve);
    CornerOCR.create = async () => ({
      scan: () => new Promise(resolve => { release = () => resolve({ marks: [{ x: 1000, y: 820, width: 100, height: 50, kind: 'ctrip', name: '携程', side: 'bottom' }], observations: [] }); started(); }),
      dispose: async () => {},
    });
    try {
      state.items[0].ocrCache = null;
      let begins = waitStart(); reanalyzeAll(); await begins;
      state.items[0].values.top = 77;
      state.items[0].manualRevision = (state.items[0].manualRevision || 0) + 1;
      renderCard(state.items[0]);
      release(); await state.pending;
      const manual = state.items[0].values.top;
      state.items[0].ocrCache = null;
      begins = waitStart(); reanalyzeAll(); await begins;
      resetSettings();
      const before = { ...state.items[0].values };
      release(); await state.pending;
      const after = { ...state.items[0].values };
      return { manual, before, after };
    } finally { CornerOCR.create = realCreate; }
  });
  assert.equal(races.manual, 77);
  assert.deepEqual(races.before, races.after);
  console.log('PASS delayed result cannot overwrite manual crop or reset settings');

  let realSamples = [];
  if (process.env.CROPPER_OCR_SAMPLES === '1') {
    const files = [];
    for (const folder of ['新版测试图', '旧版测试图']) {
      for (const name of (await fs.readdir(path.join(samples, '..', folder))).filter(name => /\.png$/i.test(name)).sort()) files.push(path.join(samples, '..', folder, name));
    }
    await page.locator('#ocrCorners').check();
    await page.locator('#fileInput').setInputFiles(files);
    await page.waitForFunction(count => state.items.length === count, files.length, { timeout: 120000 });
    const before = await page.evaluate(() => state.items.map(item => ({ name: item.file.name, values: { ...item.values } })));
    await page.evaluate(() => state.pending);
    assert.match(await page.locator('#ocrStatus').innerText(), /^四角增强识别完成/);
    realSamples = await page.evaluate(() => state.items.map(item => ({ name: item.file.name, values: item.values, photo: item.photo, marks: item.ocrMarks, scan: item.ocrCache?.scan })));
    for (let i = 0; i < realSamples.length; i++) {
      assert.equal(realSamples[i].name, before[i].name);
      // Corner OCR never restores already-confirmed borders or logos.
      for (const side of ['top', 'bottom', 'left', 'right']) assert.ok(realSamples[i].values[side] >= before[i].values[side]);
      if (realSamples[i].photo) assert.equal(realSamples[i].scan?.observations.length, 4);
    }
    console.log(`PASS optional OCR batch on all ${files.length} private samples; four corners and order preserved`);
  }
  const layout = [];
  for (const width of [320, 393, 402, 440, 874, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, label: getComputedStyle(document.querySelector('.setting > span')).fontSize, manual: getComputedStyle(document.querySelector('.crop-inputs input')).fontSize, reset: document.querySelector('#resetSettings').getBoundingClientRect().height }));
    assert.equal(metrics.overflow, false); assert.equal(metrics.label, '16px'); assert.equal(metrics.manual, '16px'); assert.ok(metrics.reset >= 44);
    layout.push({ width, ...metrics });
    if ([402, 1280].includes(width)) await page.locator('.settings-panel').screenshot({ path: path.join(dest, `parameters-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  const remote = requests.filter(r => !r.url.startsWith(url) && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  assert.deepEqual(remote, []);
  assert.equal(requests.some(r => r.method !== 'GET'), false);
  await fs.writeFile(path.join(dest, 'report.json'), JSON.stringify({ core, twoHearts, integrated, cacheInfo, races, realSamples, layout, errors, requests, device: 'desktop Chrome; not physical iPhone' }, null, 2));
  console.log('PASS no external CDN, no upload, responsive parameters; report:', dest);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
