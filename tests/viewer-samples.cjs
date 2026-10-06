// Private sample folders are local inputs only; never copy them into the site.
// node tests/viewer-samples.cjs <sample-root> <evidence-directory>
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium, webkit } = require('playwright');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
if (!process.argv[2] || !process.argv[3]) {
  console.error('用法：node tests/viewer-samples.cjs <样本根目录> <结果目录>');
  process.exit(1);
}
const samples = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
// Independent, manually inspected UI extents for the extra 19 samples.
// End ranges leave a small anti-aliasing gap above the COMPLETE logo/heart,
// not merely above the adjacent word. These coordinates are tests only.
const extra = {
  "IMG_8927.PNG": { top: 318, end: [2020, 2063] },
  "IMG_8928.PNG": { top: 507, end: [1985, 2024], mark: "amap" },
  "IMG_8929.PNG": { top: 507, end: [2020, 2063] },
  "IMG_8930.PNG": { top: 507, end: [2020, 2063] },
  "IMG_8931.PNG": { top: 507, end: [2020, 2063] },
  "IMG_8932.PNG": { top: 859, end: [1670, 1705], mark: "amap" },
  "IMG_8933.PNG": { top: 507, end: [2020, 2063] },
  "IMG_8934.PNG": { top: 507, end: [1985, 2024], mark: "amap" },
  "IMG_8936.PNG": { top: 507, end: [1985, 2024], mark: "amap" },
  "IMG_8937.PNG": { top: 507, end: [1985, 2024], mark: "amap" },
  "IMG_8938.PNG": { top: 507, end: [1985, 2024], mark: "amap" },
  "IMG_8939.PNG": { top: 507, end: [1985, 2024], mark: "amap" },
  "IMG_8940.PNG": { top: 507, end: [2020, 2063] },
  "IMG_8941.PNG": { top: 507, end: [2020, 2063] },
  "IMG_8942.PNG": { top: 909, end: [1615, 1633], mark: "elong" },
  "IMG_8943.PNG": { top: 859, end: [1645, 1673], mark: "elong" },
  "IMG_8944.PNG": { top: 910, end: [1615, 1633], mark: "elong" },
  "IMG_8945.PNG": { top: 909, end: [1615, 1633], mark: "elong" },
  "IMG_8946.PNG": { top: 909, end: [1615, 1633], mark: "elong" },
};
const colored = new Set(['IMG_8992.PNG','IMG_8993.PNG','IMG_8994.PNG','IMG_8995.PNG','IMG_8996.PNG','IMG_8997.PNG','IMG_8998.PNG','IMG_8999.PNG','IMG_9001.PNG','IMG_9002.PNG','IMG_9003.PNG','IMG_9004.PNG','IMG_9005.PNG','IMG_9006.PNG','IMG_9007.PNG','IMG_9009.PNG','IMG_9010.PNG','IMG_9011.PNG','IMG_9012.PNG','IMG_9013.PNG']);
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
  browser = process.env.CROPPER_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 402, height: 874 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const baseline = execFileSync('git', ['show', '40ff5aa:app.js'], { cwd: root, encoding: 'utf8' });
  const oldLogic = baseline.slice(0, baseline.indexOf('function cropImage('));
  const prior = execFileSync('git', ['show', '9e64741:app.js'], { cwd: root, encoding: 'utf8' });
  const priorLogic = prior.slice(0, prior.indexOf('function cropImage('));
  const priorViewer = execFileSync('git', ['show', '9e64741:viewer-detector.js'], { cwd: root, encoding: 'utf8' });
  const limitations = [];
  const report = [];
  for (const folder of ['新版测试图', '旧版测试图']) {
    const files = (await fs.readdir(path.join(samples, folder))).filter(f => /\.png$/i.test(f)).sort();
    for (const name of files) {
      await page.locator('#fileInput').setInputFiles(path.join(samples, folder, name));
      await page.waitForFunction(name => document.querySelector('.result-card h3')?.textContent === name, name);
      const result = await page.evaluate(({ oldLogic, priorLogic }) => {
        const item = state.items[0];
        const started = performance.now();
        analyzeImage(item.image);
        const analysisMs = performance.now() - started;
        const oldAnalyze = new Function('document', 'structuredClone', 'settings', oldLogic + '; state.settings = structuredClone(settings); return analyzeImage;')(document, structuredClone, state.settings);
        const oldDetected = oldAnalyze(item.image).detected;
        const priorAnalyze = new Function('document', 'structuredClone', 'settings', priorLogic + '; state.settings = structuredClone(settings); return analyzeImage;')(document, structuredClone, state.settings);
        const priorDetected = priorAnalyze(item.image).detected;
        const current = { detected: { ...item.detected }, values: { ...item.values }, viewer: item.viewer, frame: item.frame, width: item.rendered.canvas.width, height: item.rendered.canvas.height, naturalHeight: item.image.naturalHeight };
        state.settings.trimViewer = false;
        const disabled = analyzeImage(item.image).detected;
        state.settings.trimViewer = true;
        return { ...current, oldDetected, priorDetected, disabled, analysisMs };
      }, { oldLogic, priorLogic });
      if (!colored.has(name)) {
        assert.deepEqual(result.detected, result.priorDetected, name + ': v1.6 output preserved exactly');
        assert.deepEqual(result.disabled, result.oldDetected, name + ': turning the old feature off retains the previous algorithm exactly');
      }
      if (folder === '旧版测试图' && !result.viewer) assert.deepEqual(result.detected, result.oldDetected, name + ': older border-only output unchanged');
      if (folder === '旧版测试图' && result.viewer) {
        assert.ok(result.viewer.like || result.viewer.amap || result.viewer.elong);
        assert.ok(result.height > 400 && result.values.bottom > 500, name + ': older viewer footer also removed');
      }
      if (folder === '新版测试图') {
        if (process.env.CROPPER_VERBOSE) console.log('DETECT', name, JSON.stringify(result));
        if (!result.viewer && !result.frame) {
          const code = (await fs.readFile(path.join(root, 'viewer-detector.js'), 'utf8')).split('\n').map((line, i) => line.replace(/return null;/g, 'return (console.log("stop", ' + (i + 1) + '), null);')).join('\n')
            .replace('const score = similarity(box, HEART);', 'const score = similarity(box, HEART); console.log("heart", box, score);')
            .replace('if (!heart && !amap)', 'console.log("markers", heart, amap, authorBands); if (!heart && !amap)');
          console.log('DEBUG', await page.evaluate(code => { const scope = {}, messages = []; new Function('window', 'console', code)(scope, { log: (...args) => messages.push(args) }); scope.ViewerDetector.analyze(createProfile(state.items[0].image, state.settings)); return messages; }, code));
        }
        if (colored.has(name)) assert.ok(result.frame, name + ': colored/blurred viewer identified without OCR');
        else { assert.ok(result.viewer, name + ': viewer identified'); assert.ok(result.viewer.like, name + ': like control identified'); }
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
          const rendered = item.rendered.canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let sourceMax = 0, savedMax = 0, changed = 0;
          for (let i = 0; i < actual.length; i++) {
            sourceMax = Math.max(sourceMax, Math.abs(actual[i] - original[i]));
            savedMax = Math.max(savedMax, Math.abs(actual[i] - rendered[i]));
            if (actual[i] !== original[i]) changed++;
          }
          return { sourceMax, savedMax, changed, channels: actual.length };
        }, png);
        assert.equal(matches.savedMax, 0, name + ': PNG is identical to the rendered crop');
        // WebKit rounds color-managed full-image and source-rectangle draws
        // differently (up to 2/255). Export itself must stay byte-exact above.
        assert.ok(matches.sourceMax <= (process.env.CROPPER_BROWSER === 'webkit' ? 2 : 0), name + ': source colors preserved: ' + JSON.stringify(matches));
        result.pngPixels = matches;
        const expectedFile = path.join(samples, '新版需要达到的效果', name.replace(/\.png$/i, '.jpg'));
        if (extra[name]) {
          const expected = extra[name], end = result.naturalHeight - result.values.bottom;
          assert.ok(Math.abs(result.values.top - expected.top) <= 3, name + ': no toolbar residue');
          assert.ok(end >= expected.end[0] && end <= expected.end[1], name + ': full logo / standalone heart removed with bounded photo loss');
          if (expected.mark) {
            assert.equal(result.viewer[expected.mark], true, name + ': watermark identity');
            assert.ok(result.viewer.marks.some(mark => mark.kind === expected.mark), name + ': photo watermark, not just author name');
          }
          result.reference = { manuallyInspected: true, ...expected };
        } else {
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
          assert.ok(Math.abs(result.height - expectedInfo.height) <= (colored.has(name) ? 35 : 25), name + ': crop height matches reference within manual-crop tolerance');
          assert.ok(Math.abs(result.values.top - result.reference.top) <= 20, name + ': crop starts at reference content within manual-crop tolerance');
          assert.ok(best.error < 15, name + ': reference is the same photo region');
        }
      }
      report.push({ folder, name, ...result });
      console.log('PASS', folder, name, result.width + 'x' + result.height);
    }
  }
  // Persist primary original-image/export evidence independently of extras.
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
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

  // 新背景不是一套更宽的黑色阈值。只关闭界面栏会禁用新分支；方向和微调仍独立。
  for (const name of ['IMG_8992.PNG', 'IMG_9004.PNG', 'IMG_9010.PNG', 'IMG_9013.PNG']) {
    await page.locator('#fileInput').setInputFiles(path.join(samples, '新版测试图', name));
    await page.waitForFunction(name => state.items[0]?.file.name === name, name);
    const before = await page.evaluate(() => ({ ...state.items[0].values }));
    assert.ok(await page.evaluate(() => state.items[0].frame));
    await page.locator('#detectChrome').uncheck();
    assert.equal(await page.evaluate(() => state.items[0].frame), null);
    await page.locator('#detectChrome').check();
    await page.locator('.side-toggle[data-side="top"]').uncheck();
    assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].values })), { ...before, top: 0 });
    await page.locator('.side-toggle[data-side="top"]').check();
    await page.locator('.side-toggle[data-side="bottom"]').uncheck();
    assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].values })), { ...before, bottom: 0 });
    await page.locator('.side-toggle[data-side="bottom"]').check();
    for (const adjustment of [-5, -1, 3]) {
      await page.locator('#padding').evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }, String(adjustment));
      assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].values })), { top: before.top - adjustment, bottom: before.bottom - adjustment, left: 0, right: 0 });
    }
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    const noStatus = await sharp(path.join(samples, '新版测试图', name)).composite([{ input: Buffer.from('<svg width="1206" height="350"><rect width="1206" height="350" fill="#788898"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
    await page.locator('#fileInput').setInputFiles({ name: 'no-status-' + name, mimeType: 'image/png', buffer: noStatus });
    await page.waitForFunction(name => state.items[0]?.file.name === 'no-status-' + name, name);
    assert.equal(await page.evaluate(() => state.items[0].frame), null, '背景色与双边界本身不够，没有 UI 不裁');
  }
  console.log('PASS colored/blurred controls, -5/-1/+3 and no-status negatives');

  for (const name of ['IMG_8992.PNG', 'IMG_9004.PNG', 'IMG_9010.PNG', 'IMG_9013.PNG']) {
    const original = report.find(r => r.name === name);
    for (const width of [844, 1608]) {
      const buffer = await sharp(path.join(samples, '新版测试图', name)).resize({ width }).jpeg({ quality: 88 }).toBuffer();
      const variantName = name + '-' + width + '.jpg';
      await page.locator('#fileInput').setInputFiles({ name: variantName, mimeType: 'image/jpeg', buffer });
      await page.waitForFunction(name => state.items[0]?.file.name === name, variantName);
      const result = await page.evaluate(() => ({ frame: state.items[0].frame, values: state.items[0].values }));
      assert.ok(result.frame, variantName + ': colored/blurred frame survives JPEG and resizing');
      assert.equal(result.frame.marks.length, 0, variantName + ': photo detail is not guessed as a watermark');
      for (const side of ['top', 'bottom']) assert.ok(Math.abs(result.values[side] * 1206 / width - original.values[side]) <= 8, variantName + ': same photo extent');
      console.log('PASS colored variant', variantName);
    }
  }

  async function variant(name, buffer, recognized, like = null) {
    await page.evaluate(() => {
      globalThis.__testCreateProfile = createProfile;
      createProfile = (...args) => { globalThis.__testVariantProfile = __testCreateProfile(...args); return __testVariantProfile; };
    });
    await page.locator('#fileInput').setInputFiles({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', buffer });
    await page.waitForFunction(name => state.items[0]?.file.name === name, name);
    await page.evaluate(() => { createProfile = __testCreateProfile; });
    const viewer = await page.evaluate(() => state.items[0].viewer);
    if (process.env.CROPPER_BROWSER === 'webkit' && name === 'author-only.png' && !viewer) {
      const old = await page.evaluate(priorViewer => {
        const scope = {}; new Function('window', priorViewer)(scope);
        return scope.ViewerDetector.analyze(__testVariantProfile);
      }, priorViewer);
      assert.equal(old, null, 'historical detector also misses this synthetic author-only footer');
      limitations.push({ name, issue: 'Inherited v1.6 WebKit synthetic author-only footer miss' });
      console.log('LIMITED inherited WebKit author-only variant');
      return;
    }
    assert.equal(Boolean(viewer), recognized, name);
    if (like !== null) assert.equal(viewer.like, like, name);
    console.log('PASS variant', name, JSON.stringify(viewer));
  }
  for (const width of [844, 1608]) await variant('scaled-' + width + '.jpg', await sharp(seed).resize({ width }).jpeg({ quality: 90 }).toBuffer(), true, true);
  for (const name of ["IMG_8927.PNG", "IMG_8930.PNG", "IMG_8932.PNG", "IMG_8934.PNG", "IMG_8943.PNG", "IMG_8946.PNG"]) {
    for (const width of [844, 1608]) {
      const buffer = await sharp(path.join(samples, '新版测试图', name)).resize({ width }).jpeg({ quality: 88 }).toBuffer();
      await variant(name + '-' + width + '.jpg', buffer, true, true);
      const result = await page.evaluate(() => ({ viewer: state.items[0].viewer, values: state.items[0].values, height: state.items[0].image.naturalHeight }));
      if (extra[name].mark) {
        assert.equal(result.viewer[extra[name].mark], true, 'watermark recognition survives resizing and JPEG');
        if (process.env.CROPPER_BROWSER === 'webkit' && !result.viewer.marks.some(mark => mark.kind === extra[name].mark)) {
          // Preserve the established rules. An inherited miss is reported, not
          // hidden as a pass or "fixed" by loosening global logo thresholds.
          const old = await page.evaluate(priorViewer => {
            const scope = {}; new Function('window', priorViewer)(scope);
            return scope.ViewerDetector.analyze(__testVariantProfile);
          }, priorViewer);
          assert.deepEqual(result.viewer, old, 'historical detector sees the same miss on the exact decoded sample profile');
          assert.equal(old.marks.some(mark => mark.kind === extra[name].mark), false);
          limitations.push({ name, width, issue: 'Inherited v1.6 WebKit/JPEG small-logo miss; optional OCR or manual adjustment needed' });
          console.log('LIMITED inherited WebKit small-logo variant', name, width);
          continue;
        }
        assert.ok(result.viewer.marks.some(mark => mark.kind === extra[name].mark), 'resized photo mark, not just footer author');
      }
      const end = (result.height - result.values.bottom) * 1206 / width;
      assert.ok(end >= extra[name].end[0] - 6 && end <= extra[name].end[1] + 3, name + ': resized export excludes full UI mark');
    }
  }
  const hotel = await fs.readFile(path.join(samples, '新版测试图', 'IMG_8946.PNG'));
  const compactMap = await fs.readFile(path.join(samples, '新版测试图', 'IMG_8932.PNG'));
  // Exercise both orders in one photo, with a separate like in the footer.
  // Patch coordinates are private fixture construction, never production rules.
  const hotelMark = await sharp(hotel).extract({ left: 1050, top: 1625, width: 140, height: 65 }).png().toBuffer();
  const compactMapMark = await sharp(compactMap).extract({ left: 1038, top: 1695, width: 165, height: 65 }).png().toBuffer();
  const combinations = [
    { name: 'elong-above-amap-and-like.png', buffer: await sharp(compactMap).composite([{ input: hotelMark, left: 1040, top: 1570 }]).png().toBuffer(), end: [1550, 1578] },
    { name: 'amap-above-elong-and-like.png', buffer: await sharp(hotel).composite([{ input: compactMapMark, left: 1038, top: 1544 }]).png().toBuffer(), end: [1530, 1555] },
  ];
  const combinationReport = [];
  for (const sample of combinations) {
    await variant(sample.name, sample.buffer, true, true);
    const result = await page.evaluate(() => ({ viewer: state.items[0].viewer, values: state.items[0].values, height: state.items[0].image.naturalHeight }));
    if (process.env.CROPPER_BROWSER === 'webkit' && ['amap', 'elong'].some(kind => !result.viewer.marks.some(mark => mark.kind === kind))) {
      const old = await page.evaluate(priorViewer => {
        const scope = {}; new Function('window', priorViewer)(scope);
        return scope.ViewerDetector.analyze(__testVariantProfile);
      }, priorViewer);
      assert.deepEqual(result.viewer, old, 'historical detector has the identical combined-mark limitation');
      limitations.push({ name: sample.name, issue: 'Inherited v1.6 WebKit combined small-logo miss; optional OCR or manual adjustment needed' });
      console.log('LIMITED inherited WebKit combined-mark variant', sample.name);
      continue;
    }
    for (const kind of ['amap', 'elong']) assert.ok(result.viewer.marks.some(mark => mark.kind === kind), sample.name + ': both in-photo logos identified');
    const end = result.height - result.values.bottom;
    assert.ok(end >= sample.end[0] && end <= sample.end[1], sample.name + ': crop above the uppermost COMPLETE mark');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载图片', exact: true }).click();
    await (await download).saveAs(path.join(evidence, sample.name));
    combinationReport.push({ name: sample.name, expectedEnd: sample.end, ...result });
  }
  await fs.writeFile(path.join(evidence, 'combinations.json'), JSON.stringify(combinationReport, null, 2));
  console.log('Verified multi-element orders; known inherited limitations:', limitations.length);
  const logoOnly = await sharp(hotel).composite([{ input: Buffer.from('<svg width="1206" height="909"><rect width="1206" height="909" fill="black"/></svg>'), left: 0, top: 1713 }]).png().toBuffer();
  await variant('elong-without-like.png', logoOnly, true, false);
  assert.equal(await page.evaluate(() => state.items[0].viewer.elong), true, 'logo and word recognized without a heart');
  const noHotelToolbar = await sharp(hotel).composite([{ input: Buffer.from('<svg width="1206" height="318"><rect width="1206" height="318" fill="black"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
  await variant('watermark-without-viewer-toolbar.png', noHotelToolbar, false);
  // Erase only the like control for the author-only case, using a black
  // rectangle; no original sample is modified on disk.
  const png = await fs.readFile(seed);
  const glyph = await sharp(png).extract({ left: 1006, top: 2066, width: 60, height: 55 }).png().toBuffer();
  const onlyHeart = await sharp(png).composite([
    { input: Buffer.from('<svg width="1206" height="572"><rect width="1206" height="572" fill="black"/></svg>'), left: 0, top: 2050 },
    { input: glyph, left: 1006, top: 2066 },
  ]).png().toBuffer();
  await variant('one-heart-no-word-no-author.png', onlyHeart, true, true);
  const map = await fs.readFile(path.join(samples, '新版测试图', 'IMG_8934.PNG'));
  const mapOnly = await sharp(map).composite([
    { input: Buffer.from('<svg width="1206" height="506"><rect width="1206" height="506" fill="black"/></svg>'), left: 0, top: 2116 },
    { input: Buffer.from('<svg width="160" height="52"><rect width="160" height="52" fill="black"/></svg>'), left: 1006, top: 2064 },
  ]).png().toBuffer();
  await variant('amap-logo-without-like.png', mapOnly, true);
  assert.equal(await page.evaluate(() => state.items[0].viewer.amap), true);
  assert.ok(await page.evaluate(() => state.items[0].image.naturalHeight - state.items[0].values.bottom <= 2024), 'whole arrow logo removed without like text');
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
  await page.waitForFunction(count => state.items.length === count && document.querySelectorAll('.result-card').length === count, all.length, { timeout: 120000 });
  assert.equal(await page.locator('.viewer-note').count(), all.length);
  assert.deepEqual(await page.locator('.result-card h3').allTextContents(), report.filter(item => item.folder === '新版测试图').map(item => item.name));
  console.log('PASS real sample batch import and original ordering');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  if (process.env.CROPPER_BROWSER === 'webkit') {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  } else await page.context().setOffline(true);
  await page.reload();
  await page.locator('#fileInput').setInputFiles(seed);
  await page.waitForFunction(() => state.items[0]?.viewer?.like);
  assert.equal(await page.locator('.viewer-note').count(), 1);
  for (const name of ["IMG_8932.PNG", "IMG_8934.PNG", "IMG_8946.PNG"]) {
    await page.locator('#fileInput').setInputFiles(path.join(samples, '新版测试图', name));
    await page.waitForFunction(name => state.items[0]?.file.name === name && state.items[0]?.viewer, name);
    assert.equal(await page.evaluate(key => state.items[0].viewer[key], extra[name].mark), true, 'actual logo recognition works offline');
    assert.ok(await page.evaluate(key => state.items[0].viewer.marks.some(mark => mark.kind === key), extra[name].mark), 'offline in-photo mark, not just author');
  }
  console.log('PASS actual screenshot detection offline, including cached recognition module');
  for (const name of colored) {
    await page.locator('#fileInput').setInputFiles(path.join(samples, '新版测试图', name));
    await page.waitForFunction(name => state.items[0]?.file.name === name && state.items[0]?.frame, name);
    const expected = report.find(r => r.name === name).values;
    assert.deepEqual(await page.evaluate(() => ({ ...state.items[0].values })), expected);
  }
  console.log('PASS all 20 new styles offline without OCR/models');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(evidence, 'limitations.json'), JSON.stringify(limitations, null, 2));
  console.log('Evidence:', evidence);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); if (server) server.close(); });
