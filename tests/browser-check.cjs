// 端到端浏览器回归：node tests/browser-check.cjs
// 需要 playwright 包（用系统已安装的 Chrome，不必下载浏览器内核）。
// 覆盖：算法裁剪量、滑块自动重算、手动微调、方向开关、真实 PNG 导出尺寸、离线缓存启动。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { chromium, webkit } = require('playwright');
const sharp = require('sharp');

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

  browser = process.env.CROPPER_BROWSER === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  assert.equal(await page.locator('.badge').innerText(), 'v1.7.2 · 2026.10.07');
  assert.equal(await page.title(), '截图智能裁剪');
  assert.equal(await page.locator('.hero h1').innerText(), '截图智能裁剪');
  assert.equal(await page.locator('.intro').innerText(), '识别照片主体，裁掉多余留白、界面栏与角落标识。');
  const versionStyle = await page.locator('.badge').evaluate(el => {
    const css = getComputedStyle(el);
    return { border: css.borderTopWidth, background: css.backgroundColor };
  });
  assert.deepEqual(versionStyle, { border: '0px', background: 'rgba(0, 0, 0, 0)' });
  console.log('PASS 版本日期格式正确且没有外框');
  assert.deepEqual(await page.locator('.footer-note p').evaluateAll(paragraphs => paragraphs.map(el => getComputedStyle(el).fontSize)), ['14px', '14px']);
  console.log('PASS 底部两段提示均为 14px，版本号保持 v1.7.2');

  assert.equal(await page.locator('#batchActions').isVisible(), false, '空状态不得显示批量操作条');
  console.log('PASS 空状态隐藏批量操作条（.batch-actions[hidden] 生效）');
  await page.locator('.settings-panel').evaluate(el => el.open = true);
  const typography = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('.settings-summary h2, .setting > span, .setting output, .viewer-option > label')].map(el => getComputedStyle(el).fontSize),
    descriptions: [...document.querySelectorAll('.setting small, .viewer-option small, #ocrStatus')].map(el => getComputedStyle(el).fontSize),
  }));
  assert.ok(typography.titles.every(size => size === '14px'));
  assert.ok(typography.descriptions.every(size => size === '13px'));
  assert.deepEqual(await page.locator('.viewer-option input').evaluateAll(inputs => inputs.map(input => input.id)), ['detectChrome', 'trimViewer', 'ocrCorners']);
  assert.equal(await page.locator('#ocrCorners').isChecked(), false);
  console.log('PASS 确认后的紧凑布局：14px 标题/数值、13px 说明，识别选项统一排列且 OCR 默认关闭');
  const progress = await page.locator('#darkThreshold').evaluate(el => Number.parseFloat(el.style.getPropertyValue('--range-progress')));
  assert.ok(Math.abs(progress - (42 - 5) / (100 - 5) * 100) < .001);
  const track = await sharp(await page.locator('#darkThreshold').screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = x => [...track.data.subarray((Math.floor(track.info.height / 2) * track.info.width + x) * 3, (Math.floor(track.info.height / 2) * track.info.width + x) * 3 + 3)];
  assert.deepEqual(pixel(30), [83, 167, 255]);
  assert.deepEqual(pixel(track.info.width - 30), [53, 68, 90]);
  const column = x => Array.from({ length: track.info.height }, (_, y) => [...track.data.subarray((y * track.info.width + x) * 3, (y * track.info.width + x) * 3 + 3)]);
  const isBlue = ([r, g, b]) => r >= 70 && r <= 210 && g >= 145 && b >= 215;
  assert.equal(column(30).filter(isBlue).length, 4);
  const thumbPixels = column(Math.round(9 + (track.info.width - 18) * progress / 100)).filter(isBlue).length;
  assert.ok(thumbPixels >= 16 && thumbPixels <= 20);
  assert.equal(await page.locator('#darkThreshold').evaluate(el => el.getBoundingClientRect().height), 44);
  console.log('PASS 滑块真实像素：亮条 4px、圆圈约 18px，左亮蓝/右暗灰，触控高度仍 44px');
  await page.locator('#darkThreshold').focus();
  await page.locator('#darkThreshold').press('ArrowRight');
  assert.equal(await page.locator('#darkThreshold').inputValue(), '43');
  await page.locator('#resetSettings').click();
  assert.equal(await page.locator('#darkThreshold').inputValue(), '42');
  assert.equal(await page.locator('.settings-panel').evaluate(el => el.open), true);
  await page.locator('#padding').evaluate(el => el.value = '-5');
  await page.locator('#resetSettings').press('Enter');
  assert.equal(await page.locator('#padding').inputValue(), '0');
  assert.equal(await page.locator('.settings-panel').evaluate(el => el.open), true);
  await page.locator('.settings-panel').evaluate(el => el.open = false);
  await page.locator('#padding').evaluate(el => el.value = '-5');
  await page.locator('#resetSettings').press('Space');
  assert.equal(await page.locator('#padding').inputValue(), '0');
  assert.equal(await page.locator('.settings-panel').evaluate(el => el.open), false);
  await page.locator('.settings-summary').click({ position: { x: 10, y: 10 } });
  assert.equal(await page.locator('.settings-panel').evaluate(el => el.open), true);
  await page.locator('.settings-summary').click({ position: { x: 10, y: 10 } });
  assert.equal(await page.locator('.settings-panel').evaluate(el => el.open), false);
  console.log('PASS 小号滑块键盘操作、恢复默认点击/Enter/空格不误折叠，标题仍可正常展开/收起');

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
  const shares = await page.evaluate(async () => {
    const captured = [], keys = ['share', 'canShare'];
    const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(navigator, key));
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => Boolean(data.files?.length) });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => captured.push({ title: data.title, count: data.files.length }) });
    try { await shareItem(state.items[0]); await shareAllItems(); }
    finally { keys.forEach((key, i) => descriptors[i] ? Object.defineProperty(navigator, key, descriptors[i]) : delete navigator[key]); }
    return captured;
  });
  assert.deepEqual(shares, [{ title: '截图智能裁剪', count: 1 }, { title: '截图智能裁剪（1张）', count: 1 }]);
  console.log('PASS 单张和批量系统分享标题统一为新名称（测试替身，不发送文件）');

  await page.locator('.settings-panel').evaluate(el => el.open = true);
  for (const viewport of [{ width: 320, height: 850 }, { width: 393, height: 852 }, { width: 402, height: 874 }, { width: 440, height: 956 }, { width: 874, height: 402 }, { width: 1200, height: 900 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await page.locator('.settings-panel').evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('input, button, .settings-toggle, .viewer-option > label')].every(el => { const box = el.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right; });
    }));
    assert.equal(await page.locator('.hero h1').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      return range.getClientRects().length;
    }), 1, '新名称在测试宽度中保持完整一行');
    if (viewport.width <= 650) {
      const layout = await page.evaluate(() => ({
        title: document.querySelector('.hero h1').getBoundingClientRect().top,
        badge: document.querySelector('.badge').getBoundingClientRect().bottom,
        intro: document.querySelector('.intro').getBoundingClientRect().width,
        hero: document.querySelector('.hero').getBoundingClientRect().width,
      }));
      assert.ok(layout.title >= layout.badge, '版本号不得占用标题行');
      assert.equal(layout.intro, layout.hero, '手机副标题使用标题区完整宽度');
      if (viewport.width >= 402) {
        const directions = await page.evaluate(() => ({ button: document.querySelector('#reanalyze').getBoundingClientRect().top, checks: document.querySelector('.side-checks').getBoundingClientRect().top }));
        assert.equal(directions.button, directions.checks, '常用手机宽度的重新检测与方向选项保持同一行');
      }
    }
  }
  console.log('PASS 手机竖/横屏与桌面宽度均无横向溢出');
  await page.locator('.settings-panel').evaluate(el => el.open = false);

  // --- Service Worker 缓存启动 ---
  await page.setViewportSize({ width: 402, height: 874 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.locator('.hero h1').waitFor();
  if (process.env.CROPPER_BROWSER === 'webkit') {
    // WebKit 的协议级 offline 模拟会在导航前报内部错误；关闭真实 HTTP 来源验证缓存。
    const port = server.address().port;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await page.reload();
    await page.locator('.hero h1').waitFor();
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  } else {
    await context.setOffline(true);
    await page.reload();
    await page.locator('.hero h1').waitFor();
    await context.setOffline(false);
  }

  // --- 自动更新：手上有图片时不打断当前处理 ---
  await upload('border');
  await page.evaluate(() => { window.__keep = 1; });
  swVariant = 'screenshot-trimmer-v15-autotest';
  await page.evaluate(async () => { (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForTimeout(3000);
  assert.equal(await page.evaluate(() => window.__keep), 1, '有图片时不应自动刷新');
  assert.match(await page.locator('#status').innerText(), /已更新到新版本/, '应提示新版本已就绪');
  console.log('PASS 正在处理图片时遇到新版本不打断，只给出提示');

  // --- 自动更新：空闲时自动刷新 ---
  await page.reload();
  await page.locator('.hero h1').waitFor();
  await page.evaluate(() => { window.__keep2 = 1; });
  swVariant = 'screenshot-trimmer-v16-autotest';
  await page.evaluate(async () => { (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForFunction(() => window.__keep2 === undefined, null, { timeout: 20000 });
  console.log('PASS 空闲时检测到新版本自动刷新（无需用户手动清缓存）');

  // --- 首次安装不应该多刷新一次 ---
  const freshContext = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const freshPage = await freshContext.newPage();
  let freshNav = 0;
  freshPage.on('framenavigated', (f) => { if (f === freshPage.mainFrame()) freshNav += 1; });
  await freshPage.goto(url);
  await freshPage.evaluate(async () => { await navigator.serviceWorker.ready; });
  await freshPage.waitForTimeout(2500);
  assert.equal(freshNav, 1, '首次安装不应触发额外刷新');
  console.log('PASS 首次安装不额外刷新（打开不会白加载两次）');
  await freshContext.close();

  assert.deepEqual(errors, [], '页面不应有未捕获异常');
  console.log('PASS 在线 / 离线缓存启动均正常，无页面异常');

  console.log('证据目录:', downloads);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); if (server) server.close(); });
