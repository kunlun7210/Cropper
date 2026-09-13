// 真实样本回归：npm run test:samples（等价于 node tests/chrome-check.cjs）
// 需要把环境变量 CROPPER_FIXTURES 指向一批自己拍的截图目录，例如：
//   CROPPER_FIXTURES="$HOME/Pictures/测试截图" npm run test:samples
// 测试素材属于个人数据，刻意不放进仓库，也不设默认路径。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const fixtureDir = process.env.CROPPER_FIXTURES;
if (!fixtureDir) {
  console.error('缺少环境变量 CROPPER_FIXTURES。请指向一批实拍截图所在目录，例如：');
  console.error('  CROPPER_FIXTURES="$HOME/Pictures/测试截图" npm run test:samples');
  process.exit(1);
}
if (!fss.existsSync(fixtureDir)) {
  console.error(`CROPPER_FIXTURES 指向的目录不存在：${fixtureDir}`);
  process.exit(1);
}

// 期望值由开发期的 Python 镜像产出并人工核对过，这里作为回归基线固定下来。
// 注意：镜像用 PIL 缩放、浏览器用 canvas 缩放，两张图（0764/0769）的边界会
// 相差 3px（约一个 profile 行）。以浏览器为准。
const EXPECTED_ON = {
  'IMG_0761.PNG': { top: 971, bottom: 0, left: 0, right: 0 },   // 不受影响：纯黑边框
  'IMG_0770.PNG': { top: 973, bottom: 973, left: 0, right: 0 },
  'IMG_0774.PNG': { top: 860, bottom: 857, left: 0, right: 0 },
  'IMG_0776.PNG': { top: 325, bottom: 239, left: 0, right: 0 }, // 本次修复的主目标
};
const EXPECTED_OFF = {
  'IMG_0776.PNG': { top: 0, bottom: 239, left: 0, right: 0 },   // 关掉开关应回落
};

async function main() {
  const names = (await fs.readdir(fixtureDir)).filter((n) => n.toLowerCase().endsWith('.png')).sort();

  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/fixtures/')) {
      const file = path.join(fixtureDir, path.basename(pathname));
      if (!fss.existsSync(file)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'image/png');
      res.end(await fs.readFile(file));
      return;
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  const measure = (enabled) => page.evaluate(async ({ names, enabled }) => {
    state.settings.detectChrome = enabled;
    const out = {};
    for (const name of names) {
      const image = new Image();
      image.src = `/fixtures/${encodeURIComponent(name)}`;
      await image.decode();
      out[name] = { w: image.naturalWidth, h: image.naturalHeight, detected: analyzeImage(image).detected };
    }
    return out;
  }, { names, enabled });

  const on = await measure(true);
  const off = await measure(false);

  console.log('图                    尺寸        界面栏开(上/下/左/右)      界面栏关(上/下/左/右)');
  for (const name of names) {
    const a = on[name].detected, b = off[name].detected;
    const f = (d) => `${d.top}/${d.bottom}/${d.left}/${d.right}`;
    console.log(`${name.padEnd(20)} ${String(on[name].w + 'x' + on[name].h).padEnd(11)} ${f(a).padEnd(26)} ${f(b)}`);
  }

  const changed = names.filter((n) => JSON.stringify(on[n].detected) !== JSON.stringify(off[n].detected));
  console.log(`\n受界面栏识别影响的图（${changed.length} 张）：${changed.join(' ')}`);

  for (const [name, expected] of Object.entries(EXPECTED_ON)) {
    assert.ok(on[name], `缺少样本 ${name}`);
    assert.deepEqual(on[name].detected, expected, `${name} 开启界面栏识别的结果不符`);
    console.log(`PASS ${name} 开启 = ${JSON.stringify(on[name].detected)}`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_OFF)) {
    assert.deepEqual(off[name].detected, expected, `${name} 关闭界面栏识别应回落到原行为`);
    console.log(`PASS ${name} 关闭 = ${JSON.stringify(off[name].detected)}（回落正确）`);
  }

  // 开关必须真的接在界面上：勾选框存在、默认开启、改动会写回 state。
  // 开关位于折叠的「检测参数」面板内，先展开再操作。
  await page.locator('.settings-panel').evaluate((el) => { el.open = true; });
  assert.equal(await page.locator('#detectChrome').isChecked(), true, '界面栏开关默认应开启');
  await page.locator('#detectChrome').uncheck();
  assert.equal(await page.evaluate(() => state.settings.detectChrome), false, '取消勾选应写回 state');
  await page.locator('#detectChrome').check();
  assert.equal(await page.evaluate(() => state.settings.detectChrome), true, '重新勾选应写回 state');
  console.log('PASS 界面栏开关的勾选状态正确写入 state.settings');

  // 完整 UI 通路：从真实文件选择框导入，读界面上的实际裁剪量与输出尺寸。
  await page.setInputFiles('#fileInput', path.join(fixtureDir, 'IMG_0776.PNG'));
  await page.waitForSelector('.result-card .actual-crop');
  const cardText = await page.locator('.result-card').first().innerText();
  assert.match(cardText, /实际裁剪：上 325px · 下 239px · 左 0px · 右 0px/, `界面裁剪量不符：${cardText.split('\n').join(' / ')}`);
  assert.match(cardText, /输出 1206 × 2058px/, `界面输出尺寸不符：${cardText.split('\n').join(' / ')}`);
  console.log('PASS 导入 IMG_0776 后界面显示「上 325px · 下 239px」、输出 1206 × 2058px');

  assert.ok(changed.includes('IMG_0776.PNG'), 'IMG_0776 必须受界面栏识别影响');
  assert.equal(errors.length, 0, `页面异常：${errors.join(' | ')}`);
  console.log('PASS 全程无页面异常');

  await browser.close();
  server.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
