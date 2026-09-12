import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const html = read('index.html').toString();
const app = read('app.js').toString();
const worker = read('sw.js').toString();
const manifest = JSON.parse(read('manifest.json'));
const sizes = [16, 32, 48, 180, 192, 512];
const iconPath = size => `icons/icon-cai-v1-${size}.png`;

function decodePNG(data) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  assert.equal(data[24], 8, '8-bit pixels');
  assert.ok([2, 6].includes(data[25]), 'RGB or RGBA');
  assert.equal(data[28], 0, 'non-interlaced');
  const channels = data[25] === 6 ? 4 : 3;
  const chunks = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  assert.equal(raw.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= channels ? pixels[i - channels] : 0;
      const b = y ? pixels[i - stride] : 0;
      const c = y && x >= channels ? pixels[i - stride - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[i] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

for (const size of sizes) test(`${size}px: opaque black background and centered single glyph`, () => {
  const { width, height, channels, pixels } = decodePNG(read(iconPath(size)));
  assert.equal(width, size); assert.equal(height, size);
  let minX = size, minY = size, maxX = 0, maxY = 0, ink = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * channels;
    if (channels === 4) assert.equal(pixels[i + 3], 255, 'no transparent border');
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) assert.deepEqual([...pixels.subarray(i, i + 3)], [11, 18, 32]);
    if (pixels[i] > 110) {
      ink++; minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  assert.ok(ink > size * size * 0.07 && ink < size * size * 0.3, 'visible glyph, no blank icon');
  assert.ok(Math.abs((minX + maxX + 1) / 2 - size / 2) <= 1);
  assert.ok(Math.abs((minY + maxY + 1) / 2 - size / 2) <= 1);
  assert.ok(Math.max(maxX - minX + 1, maxY - minY + 1) <= size * 0.6 + 1, 'maskable safe zone');
});

test('SVG is an outlined 裁, not a font-dependent symbol', () => {
  const svg = read('icons/icon-cai-v1.svg').toString();
  assert.match(svg, /<title>裁<\/title>/);
  assert.match(svg, /<path fill="#f6f8fb" d="M/);
  assert.doesNotMatch(svg, /<text|<image|font-family|去|转换|流/);
});

test('ICO contains the matching 16/32/48px PNGs', () => {
  const ico = read('icons/favicon-cai-v1.ico');
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 3);
  [16, 32, 48].forEach((size, index) => {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size); assert.equal(ico[entry + 1], size);
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.deepEqual(ico.subarray(offset, offset + length), read(iconPath(size)));
  });
});

test('bookmark, Apple, PWA and preview references all use cai-v1 assets', () => {
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="icons\/icon-cai-v1-180.png"/);
  assert.match(html, /rel="icon"[^>]+favicon-cai-v1.ico/);
  assert.match(html, /rel="icon"[^>]+icon-cai-v1.svg/);
  assert.match(html, /rel="manifest" href="manifest.json\?v=cai-v1"/);
  assert.match(html, /property="og:image" content="https:\/\/kunlun7210.github.io\/Cropper\/icons\/icon-cai-v1-512.png"/);
  assert.match(html, /name="twitter:image" content="https:\/\/kunlun7210.github.io\/Cropper\/icons\/icon-cai-v1-512.png"/);
  assert.deepEqual(manifest.icons.map(icon => icon.src), [iconPath(180), iconPath(192), iconPath(512)]);
  for (const icon of manifest.icons) assert.equal(icon.purpose, icon.sizes === '180x180' ? 'any' : 'any maskable');
  assert.equal(manifest.scope, './');
  assert.match(html, /name="apple-mobile-web-app-title" content="截图去黑边"/);
  assert.equal((html.match(/property="og:image" /g) || []).length, 1);
  assert.doesNotMatch(html + JSON.stringify(manifest), /icon-qu|favicon-qu|subflow/);
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(icon.src, root)));
});

test('boundary adjustment ranges from -5 to 30 and defaults to zero', () => {
  assert.match(html, /<span>边界微调 <output id="paddingValue">0 px<\/output><\/span>/);
  assert.match(html, /<input id="padding" type="range" min="-5" max="30" step="1" value="0"/);
  assert.match(html, /负数向主体内多裁，0 按检测边界裁剪，正数保留相应像素/);
});

test('negative adjustment only trims sides where a border was detected', () => {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '0', textContent: '', hidden: false, innerHTML: '', addEventListener() {} });
      return elements.get(id);
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({ document, navigator: {}, window: { isSecureContext: false }, structuredClone });
  vm.runInContext(app, context);
  const calculate = padding => JSON.parse(vm.runInContext(`state.settings.padding = ${padding}; JSON.stringify(applyPadding({ top: 8, bottom: 0, left: 3, right: 0 }))`, context));
  assert.deepEqual(calculate(-5), { top: 13, bottom: 0, left: 8, right: 0 });
  assert.deepEqual(calculate(-1), { top: 9, bottom: 0, left: 4, right: 0 });
  assert.deepEqual(calculate(0), { top: 8, bottom: 0, left: 3, right: 0 });
  assert.deepEqual(calculate(2), { top: 6, bottom: 0, left: 1, right: 0 });
});

test('cache includes all declared icons and only removes this project old caches', async () => {
  const handlers = {}, deleted = [];
  vm.runInNewContext(worker, {
    self: { addEventListener: (name, fn) => handlers[name] = fn, clients: { claim() {} } },
    caches: { keys: async () => ['screenshot-trimmer-v7', 'screenshot-trimmer-v8', 'screenshot-trimmer-v9', 'subflow-v9'], delete: async key => deleted.push(key) }
  });
  let finished;
  handlers.activate({ waitUntil(promise) { finished = promise; } });
  await finished;
  assert.deepEqual(deleted, ['screenshot-trimmer-v7', 'screenshot-trimmer-v8']);
  for (const file of [...sizes.map(iconPath), 'icons/icon-cai-v1.svg', 'icons/favicon-cai-v1.ico']) assert.ok(worker.includes(`./${file}`));
});

test('old bookmark icon URLs also serve 裁 rather than 去', () => {
  const legacy = { 'favicon-qu-32.png': 32, 'favicon-qu-48.png': 48, 'apple-touch-icon-qu.png': 180, 'icon-qu-192.png': 192, 'icon-qu-512.png': 512 };
  for (const [path, size] of Object.entries(legacy)) assert.deepEqual(read(path), read(iconPath(size)));
});

test('cached startup still returns before a slow background fetch', async () => {
  const handlers = {}, cached = { cached: true };
  vm.runInNewContext(worker, {
    URL,
    self: { location: { origin: 'https://kunlun7210.github.io' }, addEventListener: (name, fn) => handlers[name] = fn },
    fetch: () => new Promise(() => {}),
    caches: { match: async () => cached }
  });
  let response;
  handlers.fetch({ request: { method: 'GET', url: 'https://kunlun7210.github.io/luban/' }, waitUntil() {}, respondWith(promise) { response = promise; } });
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cached startup blocked')), 300); timer.unref(); });
  assert.equal(await Promise.race([response, timeout]), cached);
});
