// Private sample folders are local inputs only; never copy them into the site.
// node tests/viewer-samples.cjs <sample-root> <evidence-directory>
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
if (!process.argv[2] || !process.argv[3]) {
  console.error('用法：node tests/viewer-samples.cjs <样本根目录> <结果目录>');
  process.exit(1);
}
const samples = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
let browser, server;
async function main() {
  await fs.mkdir(evidence, { recursive: true });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  server = http.createServer(async (req, res) => {
    const file = path.resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try { res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(await fs.readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 402, height: 874 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const baseline = execFileSync('git', ['show', '40ff5aa:app.js'], { cwd: root, encoding: 'utf8' });
  const oldLogic = baseline.slice(0, baseline.indexOf('function cropImage('));
  const report = [];
  for (const folder of ['新版测试图', '旧版测试图']) {
    const files = (await fs.readdir(path.join(samples, folder))).filter(f => /\.png$/i.test(f)).sort();
    for (const name of files) {
      await page.locator('#fileInput').setInputFiles(path.join(samples, folder, name));
      await page.waitForFunction(name => document.querySelector('.result-card h3')?.textContent === name, name);
      const result = await page.evaluate(oldLogic => {
        const item = state.items[0];
        const started = performance.now();
        analyzeImage(item.image);
        const analysisMs = performance.now() - started;
        const oldAnalyze = new Function('document', 'structuredClone', 'settings', oldLogic + '; state.settings = structuredClone(settings); return analyzeImage;')(document, structuredClone, state.settings);
        const oldDetected = oldAnalyze(item.image).detected;
        const current = { detected: { ...item.detected }, values: { ...item.values }, viewer: item.viewer, width: item.rendered.canvas.width, height: item.rendered.canvas.height };
        state.settings.trimViewer = false;
        const disabled = analyzeImage(item.image).detected;
        state.settings.trimViewer = true;
        return { ...current, oldDetected, disabled, analysisMs };
      }, oldLogic);
      assert.deepEqual(result.disabled, result.oldDetected, 'turning the feature off retains the previous algorithm exactly');
      if (folder === '旧版测试图' && !result.viewer) assert.deepEqual(result.detected, result.oldDetected, name + ': older border-only output unchanged');
      if (folder === '旧版测试图' && result.viewer) {
        assert.ok(result.viewer.like || result.viewer.amap);
        assert.ok(result.height > 400 && result.values.bottom > 500, name + ': older viewer footer also removed');
      }
      if (folder === '新版测试图') {
        console.log('DETECT', name, JSON.stringify(result));
        if (!result.viewer) {
          const code = (await fs.readFile(path.join(root, 'viewer-detector.js'), 'utf8')).split('\n').map((line, i) => line.replace(/return null;/g, 'return (console.log("stop", ' + (i + 1) + '), null);')).join('\n')
            .replace('const score = similarity(box, HEART);', 'const score = similarity(box, HEART); console.log("heart", box, score);')
            .replace('if (!heart && !amap)', 'console.log("markers", heart, amap, authorBands); if (!heart && !amap)');
          console.log('DEBUG', await page.evaluate(code => { const scope = {}, messages = []; new Function('window', 'console', code)(scope, { log: (...args) => messages.push(args) }); scope.ViewerDetector.analyze(createProfile(state.items[0].image, state.settings)); return messages; }, code));
        }
        assert.ok(result.viewer, name + ': viewer identified');
        assert.ok(result.viewer.like, name + ': like control identified');
        assert.ok(result.values.bottom >= 500);
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: '下载图片', exact: true }).click();
        const output = path.join(evidence, name);
        await (await download).saveAs(output);
        const png = (await fs.readFile(output)).toString('base64');
        const matches = await page.evaluate(async png => {
          const item = state.items[0];
          const saved = new Image(); saved.src = 'data:image/png;base64,' + png; await saved.decode();
          const canvas = document.createElement('canvas'); canvas.width = saved.naturalWidth; canvas.height = saved.naturalHeight;
          const context = canvas.getContext('2d'); context.drawImage(saved, 0, 0);
          const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const original = document.querySelector('.preview-canvas').getContext('2d').getImageData(item.values.left, item.values.top, canvas.width, canvas.height).data;
          return actual.every((v, i) => v === original[i]);
        }, png);
        assert.equal(matches, true, 'PNG preserves cropped pixels as decoded by the browser');
        const expectedFile = path.join(samples, '新版需要达到的效果', name.replace(/\.png$/i, '.jpg'));
        const expectedInfo = await sharp(expectedFile).metadata();
        // The references were manually cropped and JPEG-encoded. Compare the
        // overlapping content after a bounded translation, not JPEG bytes.
        const source = await sharp(path.join(samples, folder, name)).resize({ width: 240 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const target = await sharp(expectedFile).resize({ width: 240 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let best = { error: Infinity, top: 0 };
        for (let top = 0; top <= source.info.height - target.info.height; top++) {
          let error = 0, count = 0;
          for (let y = 3; y < target.info.height - 3; y += 5) for (let x = 3; x < 237; x += 5) {
            const a = ((y + top) * 240 + x) * 3, b = (y * 240 + x) * 3;
            for (let c = 0; c < 3; c++) { error += Math.abs(source.data[a + c] - target.data[b + c]); count++; }
          }
          error /= count;
          if (error < best.error) best = { error, top };
        }
        result.reference = { width: expectedInfo.width, height: expectedInfo.height, top: Math.round(best.top / 240 * 1206), averagePixelError: best.error };
        assert.ok(Math.abs(result.width - expectedInfo.width) <= 3);
        assert.ok(Math.abs(result.height - expectedInfo.height) <= 25, name + ': crop height matches reference within manual-crop tolerance');
        assert.ok(Math.abs(result.values.top - result.reference.top) <= 20, name + ': crop starts at reference content within manual-crop tolerance');
        assert.ok(best.error < 15, name + ': reference is the same photo region');
      }
      report.push({ folder, name, ...result });
      console.log('PASS', folder, name, result.width + 'x' + result.height);
    }
  }
  const seed = path.join(samples, '新版测试图', 'IMG_1020.PNG');
  await page.locator('#fileInput').setInputFiles(seed);
  await page.waitForFunction(() => state.items[0]?.file.name === 'IMG_1020.PNG');
  const enabled = await page.evaluate(() => ({ ...state.items[0].detected }));
  await page.locator('.settings-summary').click();
  await page.locator('#trimViewer').uncheck();
  assert.equal(await page.locator('.viewer-note').count(), 0);
  assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].detected })), report[0].oldDetected);
  await page.locator('#trimViewer').check();
  assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].detected })), enabled);
  for (const threshold of ['5', '100']) {
    await page.locator('#darkThreshold').evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }, threshold);
    assert.ok(await page.evaluate(() => state.items[0].viewer), 'viewer recognition is independent of black-edge thresholds');
  }
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await page.locator('#detectChrome').uncheck();
  const withoutChrome = await page.evaluate(oldLogic => {
    const oldAnalyze = new Function('document', 'structuredClone', 'settings', oldLogic + '; state.settings = structuredClone(settings); return analyzeImage;')(document, structuredClone, state.settings);
    return { actual: state.items[0].detected.top, baseline: oldAnalyze(state.items[0].image).detected.top };
  }, oldLogic);
  assert.equal(withoutChrome.actual, withoutChrome.baseline, 'original chrome toggle retains control of top detection');
  await page.locator('#detectChrome').check();
  await page.locator('.side-toggle[data-side="bottom"]').uncheck();
  assert.equal(await page.evaluate(() => state.items[0].viewer), null);
  assert.equal(await page.evaluate(() => state.items[0].detected.bottom), 0);
  await page.locator('.side-toggle[data-side="bottom"]').check();
  await page.locator('.side-toggle[data-side="top"]').uncheck();
  assert.equal(await page.evaluate(() => state.items[0].detected.top), 0);
  assert.equal(await page.evaluate(() => state.items[0].detected.bottom), enabled.bottom);
  await page.locator('.side-toggle[data-side="top"]').check();
  await page.locator('#padding').evaluate(el => { el.value = '-5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].values })), { top: enabled.top + 5, bottom: enabled.bottom + 5, left: 0, right: 0 });
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  console.log('PASS feature toggle, independent side selection and -5 adjustment');

  async function variant(name, buffer, recognized, like = null) {
    await page.locator('#fileInput').setInputFiles({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', buffer });
    await page.waitForFunction(name => state.items[0]?.file.name === name, name);
    const viewer = await page.evaluate(() => state.items[0].viewer);
    assert.equal(Boolean(viewer), recognized, name);
    if (like !== null) assert.equal(viewer.like, like, name);
    console.log('PASS variant', name, JSON.stringify(viewer));
  }
  for (const width of [844, 1608]) await variant('scaled-' + width + '.jpg', await sharp(seed).resize({ width }).jpeg({ quality: 90 }).toBuffer(), true, true);
  // Erase only the like control for the author-only case, using a black
  // rectangle; no original sample is modified on disk.
  const png = await fs.readFile(seed);
  const authorOnly = await sharp(png).composite([{ input: Buffer.from('<svg width="216" height="65"><rect width="216" height="65" fill="black"/></svg>'), left: 990, top: 2060 }]).png().toBuffer();
  await variant('author-only.png', authorOnly, true, false);
  for (const shape of ['rect', 'circle']) {
    const mark = shape === 'rect' ? '<rect x="21" y="8" width="54" height="47" fill="none" stroke="white" stroke-width="4"/>' : '<ellipse cx="48" cy="31" rx="27" ry="23" fill="none" stroke="white" stroke-width="4"/>';
    const blank = await sharp(png).composite([{ input: Buffer.from('<svg width="1206" height="572"><rect width="1206" height="572" fill="black"/>' + '<g transform="translate(990,10)">' + mark + '</g></svg>'), left: 0, top: 2050 }]).png().toBuffer();
    await variant('false-' + shape + '.png', blank, false);
  }
  const noToolbar = await sharp(png).composite([{ input: Buffer.from('<svg width="1206" height="318"><rect width="1206" height="318" fill="black"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
  await variant('no-toolbar.png', noToolbar, false);
  await page.locator('#fileInput').setInputFiles(seed);
  await page.waitForFunction(() => state.items[0]?.file.name === 'IMG_1020.PNG');
  await page.locator('.settings-summary').click();
  await page.screenshot({ path: path.join(evidence, 'mobile-preview.png'), fullPage: true });
  const all = report.filter(item => item.folder === '新版测试图').map(item => path.join(samples, item.folder, item.name));
  await page.locator('#fileInput').setInputFiles(all);
  await page.waitForFunction(() => state.items.length === 8 && document.querySelectorAll('.result-card').length === 8);
  assert.equal(await page.locator('.viewer-note').count(), 8);
  assert.deepEqual(await page.locator('.result-card h3').allTextContents(), report.filter(item => item.folder === '新版测试图').map(item => item.name));
  console.log('PASS real sample batch import and original ordering');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.context().setOffline(true);
  await page.reload();
  await page.locator('#fileInput').setInputFiles(seed);
  await page.waitForFunction(() => state.items[0]?.viewer?.like);
  assert.equal(await page.locator('.viewer-note').count(), 1);
  console.log('PASS actual screenshot detection offline, including cached recognition module');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Evidence:', evidence);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); if (server) server.close(); });
