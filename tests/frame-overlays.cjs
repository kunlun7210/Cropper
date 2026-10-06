// Private fixtures remain local. Verify legacy marks on the new colored frame.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const samples = process.argv[2];
if (!samples) throw new Error('Provide private sample directory');
let browser, server;
(async () => {
  server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = process.env.CROPPER_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const base = path.join(samples, 'IMG_8992.PNG');
  const amap = await sharp(path.join(samples, 'IMG_8932.PNG')).extract({ left: 1038, top: 1695, width: 165, height: 65 }).png().toBuffer();
  const elong = await sharp(path.join(samples, 'IMG_8946.PNG')).extract({ left: 1050, top: 1625, width: 140, height: 65 }).png().toBuffer();
  const heart = await sharp(path.join(samples, 'IMG_1020.PNG')).extract({ left: 1006, top: 2066, width: 60, height: 55 }).png().toBuffer();
  const variants = [
    { name: 'amap', patch: amap, x: 1038 },
    { name: 'elong', patch: elong, x: 1050 },
    { name: 'heart', patch: heart, x: 1006 },
  ];
  for (const fixture of variants) {
    const buffer = await sharp(base).composite([{ input: fixture.patch, left: fixture.x, top: 1635 }]).png().toBuffer();
    await page.locator('#fileInput').setInputFiles({ name: fixture.name + '.png', mimeType: 'image/png', buffer });
    await page.waitForFunction(name => state.items[0]?.file.name === name + '.png', fixture.name);
    const result = await page.evaluate(() => ({ frame: state.items[0].frame, values: state.items[0].values }));
    assert.ok(result.frame?.marks.some(mark => mark.kind === fixture.name), JSON.stringify(result));
    assert.ok(2622 - result.values.bottom <= 1645 && 2622 - result.values.bottom >= 1600, 'Complete logo/heart cut with bounded scene loss');
    await page.locator('.settings-panel').evaluate(el => el.open = true);
    await page.locator('#trimViewer').uncheck();
    assert.equal(await page.evaluate(() => 2622 - state.items[0].values.bottom), 1713, 'Turning marks off retains the complete photo');
    await page.locator('#trimViewer').check();
    console.log('PASS colored frame + legacy', fixture.name);
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
