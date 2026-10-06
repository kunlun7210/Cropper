// Download only declared public official assets; generate small foreground references.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'brand-assets/sources.json'), 'utf8'));
const downloads = '/Users/kunlun/Codex/2026-08-17/ios-cropper/outputs/brand-downloads-v16';
await mkdir(downloads, { recursive: true });
await mkdir(path.join(root, 'brand-assets/logos'), { recursive: true });
const templates = [], evidence = [];
for (const brand of config.brands) {
  const rawPath = path.join(downloads, `${brand.id}.image`);
  let original;
  if (process.argv.includes('--offline')) original = await readFile(rawPath);
  else {
    const { stdout } = await run('curl', ['-L', '--compressed', '--max-time', '25', '-fsS', brand.asset.startsWith('embedded:') ? brand.page : brand.asset], { encoding: 'buffer', maxBuffer: 4000000 });
    if (brand.asset.startsWith('embedded:')) {
      const html = stdout.toString('utf8'), start = html.indexOf('id="headerLogo"');
      const data = html.slice(start).match(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
      if (start < 0 || !data) throw new Error('高德官网标识缺失');
      original = Buffer.from(data[1], 'base64');
    } else original = stdout;
    await writeFile(rawPath, original);
  }
  const { data, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const samples = [0, info.width - 1, (info.height - 1) * info.width, info.width * info.height - 1].map(i => [...data.subarray(i * 4, i * 4 + 4)]);
  const transparent = samples.some(p => p[3] < 10);
  const bg = samples[0];
  let xmin = info.width, ymin = info.height, xmax = -1, ymax = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    const fg = transparent ? data[i + 3] > 40 : Math.max(...[0, 1, 2].map(c => Math.abs(data[i + c] - bg[c]))) > 36;
    if (fg) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    else data[i + 3] = 0;
  }
  if (xmax < xmin || ymax < ymin) throw new Error(`${brand.name}标识不是有效图片`);
  const logo = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: xmin, top: ymin, width: xmax - xmin + 1, height: ymax - ymin + 1 }).resize({ width: 192, height: 80, fit: 'inside' }).png().toBuffer();
  await writeFile(path.join(root, 'brand-assets/logos', `${brand.id}.png`), logo);
  const { data: mask, info: dims } = await sharp(logo).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = Array.from({ length: dims.height }, (_, y) => Array.from({ length: dims.width }, (_, x) => mask[(y * dims.width + x) * 4 + 3] > 70 ? '1' : '0').join(''));
  templates.push({ id: brand.id, name: brand.name, width: dims.width, height: dims.height, mask: rows, rgba: mask.toString('base64') });
  evidence.push({ ...brand, originalWidth: info.width, originalHeight: info.height, sha256: createHash('sha256').update(original).digest('hex'), foreground: { left: xmin, top: ymin, right: xmax + 1, bottom: ymax + 1 } });
  console.log(`OK ${brand.name} ${info.width}x${info.height} -> ${dims.width}x${dims.height}`);
}
await writeFile(path.join(root, 'brand-assets/templates.json'), JSON.stringify({ version: 1, templates }, null, 2) + '\n');
await writeFile(path.join(root, 'brand-assets/provenance.json'), JSON.stringify({ date: config.retrieved, brands: evidence }, null, 2) + '\n');
