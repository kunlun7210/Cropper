// 端到端浏览器回归：node tests/browser-check.cjs
// 需要 playwright 包（用系统已安装的 Chrome，不必下载浏览器内核）。
// 覆盖：算法裁剪量、滑块自动重算、手动微调、方向开关、真实 PNG 导出尺寸、离线缓存启动。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// 合成用例的期望值，与 app.js 的 contentBands/subjectBand/borderPurity 一致。
// letterbox 复刻真实故障场景：工具条 + 一大条黑边把画面中心包住。
const FIXTURES = {
  border: { w: 200, h: 160 },
  letterbox: { w: 200, h: 330 },
  stripe: { w: 200, h: 160 },
  smalldark: { w: 200, h: 500 },
  white: { w: 200, h: 160 },
  black: { w: 200, h: 160 },
  thin: { w: 200, h: 160 },
};

let browser, server, page, context, errors;
let swVariant = null;

async function main() {
  server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      // 用于测试"新版本自动刷新"：把 sw.js 内容换掉即可让浏览器认为有新版本
      if (pathname === '/sw.js' && swVariant) {
        const src = await fs.readFile(file, 'utf8');
        res.setHeader('Content-Type', 'text/javascript');
        res.end(src.replace(/screenshot-trimmer-v\d+/g, swVariant));
        return;
      }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  assert.equal(await page.locator('#batchActions').isVisible(), false, '空状态不得显示批量操作条');
  console.log('PASS 空状态隐藏批量操作条（.batch-actions[hidden] 生效）');

  const fixtures = await page.evaluate((names) => {
    const out = {};
    for (const name of names) {
      const { w, h } = { border: { w: 200, h: 160 }, letterbox: { w: 200, h: 330 }, stripe: { w: 200, h: 160 }, smalldark: { w: 200, h: 500 }, white: { w: 200, h: 160 }, black: { w: 200, h: 160 }, thin: { w: 200, h: 160 } }[name];
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = 'white'; g.fillRect(0, 0, w, h);
      if (name === 'border') {
        g.fillStyle = 'black'; g.fillRect(0, 0, w, h);
        for (let y = 20; y < 140; y += 1) for (let x = 20; x < 180; x += 1) { g.fillStyle = `rgb(255,${y},${x})`; g.fillRect(x, y, 1, 1); }
      }
      if (name === 'letterbox') {
        g.fillStyle = '#5a5a5f'; g.fillRect(0, 0, w, 30);
        g.fillStyle = 'black'; g.fillRect(0, 30, w, 150);
        g.fillStyle = '#dfe7ef'; g.fillRect(0, 180, w, 150);
      }
      if (name === 'stripe') { g.fillStyle = 'black'; g.fillRect(0, 20, w, 20); }
      if (name === 'smalldark') { g.fillStyle = 'black'; g.fillRect(0, 100, w, 20); }
      if (name === 'black') { g.fillStyle = 'black'; g.fillRect(0, 0, w, h); }
      if (name === 'thin') { g.fillStyle = 'black'; g.fillRect(0, 0, w, 1); }
      out[name] = c.toDataURL().split(',')[1];
    }
    return out;
  }, Object.keys(FIXTURES));

  async function setPadding(value) {
    await page.locator('#padding').evaluate((el, val) => {
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  async function upload(name) {
    await page.locator('#fileInput').setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: Buffer.from(fixtures[name], 'base64') });
    await page.locator('.result-card h3').filter({ hasText: `${name}.png` }).waitFor();
  }
  async function expectOutput(width, height) {
    await page.waitForFunction(([w, h]) => {
      const i = document.querySelector('.result-image');
      return i && i.complete && i.naturalWidth === w && i.naturalHeight === h;
    }, [width, height]);
    assert.match(await page.locator('.result-head').innerText(), new RegExp(`输出 ${width} × ${height}px`));
  }
  async function actualCrop() { return (await page.locator('.actual-crop').innerText()).replace(/\s+/g, ' ').trim(); }

  await page.locator('.settings-summary').click();

  // --- 滑块在导入前就生效（9/7 UI 修复点）---
  await setPadding(-5);
  await upload('border');
  await expectOutput(150, 110);
  assert.match(await actualCrop(), /上 25px · 下 25px · 左 25px · 右 25px/, '边界微调 -5 应把 20px 边框裁成 25px');
  console.log('PASS 导入前设置的边界微调会被应用（border -5 → 150×110）');

  // --- 滑块改动自动重算既有图片 ---
  for (const [value, w, h] of [[0, 160, 120], [-1, 158, 118], [3, 166, 126], [-5, 150, 110]]) {
    await setPadding(value);
    await expectOutput(w, h);
  }
  console.log('PASS 滑块改动自动重算（0 / -1 / +3 / -5）');

  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expectOutput(160, 120);

  // --- 手动微调（9/7 修复了 dataset 键名，之前完全无效）---
  await page.locator('.fine-tune summary').click();
  await page.locator('[data-side-input="top"]').fill('30');
  await page.locator('.hero h1').click();
  await expectOutput(160, 110);
  assert.equal(await page.locator('[data-side-input="top"]').inputValue(), '30');
  await page.getByRole('button', { name: '重新裁剪', exact: true }).click();
  await expectOutput(160, 110);
  console.log('PASS 手动微调上边 30px 即时生效且在重新裁剪后保留');

  // --- 真实 PNG 导出尺寸 ---
  const downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'cropper-browser-check-'));
  async function save(name, w, h) {
    const ready = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载图片', exact: true }).click();
    const download = await ready;
    const file = path.join(downloads, name);
    await download.saveAs(file);
    const data = await fs.readFile(file);
    assert.equal(data.readUInt32BE(16), w, `${name} PNG 宽度`);
    assert.equal(data.readUInt32BE(20), h, `${name} PNG 高度`);
  }
  await save('manual-top.png', 160, 110);
  console.log('PASS 导出 PNG 的实际像素尺寸与界面一致');

  // --- 核心回归：letterbox 场景必须裁掉工具条 + 黑边 ---
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await upload('letterbox');
  await expectOutput(200, 150);
  assert.match(await actualCrop(), /上 180px · 下 0px · 左 0px · 右 0px/, 'letterbox 只应从上方裁掉黑边');
  await save('letterbox.png', 200, 150);
  await setPadding(-5);
  await expectOutput(200, 145);
  await setPadding(0);
  console.log('PASS letterbox（工具条+黑边包住中心）→ 上裁 180px，输出 200×150');

  // --- 中心段之外没有连续内容的区域一律裁掉；小暗块受低位阈值保护 ---
  await upload('stripe');
  await expectOutput(200, 120);
  assert.match(await actualCrop(), /上 40px · 下 0px · 左 0px · 右 0px/, 'stripe 应裁到中心段起点');
  for (const name of ['white', 'black', 'thin', 'smalldark']) {
    await upload(name);
    await expectOutput(name === 'smalldark' ? 200 : 200, name === 'smalldark' ? 500 : 160);
    assert.match(await actualCrop(), /上 0px · 下 0px · 左 0px · 右 0px/, `${name} 不应被裁剪`);
  }
  console.log('PASS 无黑边 / 全黑 / 过细黑线 / 小暗块 均保持原样；内部黑条按中心段裁掉');

  // --- 方向开关 ---
  await page.locator('.side-toggle[data-side="left"]').uncheck();
  await page.locator('.side-toggle[data-side="right"]').uncheck();
  await upload('border');
  await expectOutput(200, 120);
  assert.match(await actualCrop(), /上 20px · 下 20px · 左 0px · 右 0px/);
  console.log('PASS 关闭左右检测方向后对应边不再裁剪');

  // --- 多尺寸布局不出横向滚动 ---
  for (const viewport of [{ width: 402, height: 874 }, { width: 874, height: 402 }, { width: 1200, height: 900 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  console.log('PASS 手机竖/横屏与桌面宽度均无横向溢出');

  // --- Service Worker 缓存启动 ---
  await page.setViewportSize({ width: 402, height: 874 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.locator('.hero h1').waitFor();
  await context.setOffline(true);
  await page.reload();
  await page.locator('.hero h1').waitFor();
  await context.setOffline(false);

  // 版本自动更新：换掉 sw.js 内容后触发 update()，页面应自动刷新，用户不必手动清缓存
  let navigations = 0;
  const onNav = (f) => { if (f === page.mainFrame()) navigations += 1; };
  page.on('framenavigated', onNav);
  await page.evaluate(() => { window.__stillOldBuild = true; });
  swVariant = 'screenshot-trimmer-v15-autotest';
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  });
  await page.waitForFunction(() => window.__stillOldBuild === undefined, null, { timeout: 20000 });
  page.off('framenavigated', onNav);
  assert.ok(navigations >= 1, '应至少发生一次自动刷新');
  console.log('PASS 检测到新版本后页面自动刷新（无需用户手动清缓存）');

  assert.deepEqual(errors, [], '页面不应有未捕获异常');
  console.log('PASS 在线 / 离线缓存启动均正常，无页面异常');

  console.log('证据目录:', downloads);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); if (server) server.close(); });
