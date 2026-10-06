import { build } from 'vite';
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'ocr/runtime-v1');
await build({
  configFile: false, root, base: './', publicDir: false,
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  build: {
    outDir: dest, emptyOutDir: true, target: 'es2022',
    rolldownOptions: {
      input: path.join(root, 'src/ocr-engine.mjs'), preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'engine.js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});
await mkdir(path.join(dest, 'ort'), { recursive: true });
await copyFile(path.join(root, 'brand-assets/templates.json'), path.join(dest, 'brand-logos.json'));
for (const file of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await copyFile(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(dest, 'ort', file));
}
const models = [
  ['PP-OCRv6_small_det_onnx_infer.tar', 'd218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4'],
  ['PP-OCRv6_small_rec_onnx_infer.tar', 'd267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1'],
];
await mkdir(path.join(root, 'ocr/models-v1'), { recursive: true });
await mkdir(path.join(root, 'ocr/licenses'), { recursive: true });
await copyFile(path.join(root, 'node_modules/@techstark/opencv-js/LICENSE'), path.join(root, 'ocr/licenses/Apache-2.0.txt'));
await copyFile(path.join(root, 'node_modules/js-yaml/LICENSE'), path.join(root, 'ocr/licenses/js-yaml.txt'));
for (const [file, hash] of models) {
  const source = process.argv[2] ? path.join(process.argv[2], file) : path.join(root, 'ocr/models-v1', file);
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`模型校验失败：${file}`);
  if (source !== path.join(root, 'ocr/models-v1', file)) await copyFile(source, path.join(root, 'ocr/models-v1', file));
}
async function inventory(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await inventory(full));
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}
const files = await inventory(dest);
files.push(...models.map(([name]) => `ocr/models-v1/${name}`));
const manifest = [];
for (const file of files.sort()) {
  const bytes = await readFile(path.join(root, file));
  manifest.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(path.join(root, 'ocr/manifest-v1.json'), JSON.stringify({ version: 1, files: manifest }, null, 2) + '\n');
