import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
test("bookmarks, Home Screen and share previews all use the Qu artwork", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const worker = await readFile(new URL("sw.js", root), "utf8");
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  for (const [filename, size] of [["favicon-qu-32.png", 32], ["favicon-qu-48.png", 48], ["apple-touch-icon-qu.png", 180], ["icon-qu-192.png", 192], ["icon-qu-512.png", 512]]) {
    const png = await readFile(new URL(filename, root));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 2, "RGB artwork has no transparent padding");
    assert.ok(html.includes(filename));
    assert.ok(worker.includes(`"./${filename}"`));
    if (size >= 180) assert.ok(manifest.icons.some(icon => icon.src === `./${filename}` && icon.sizes === `${size}x${size}`));
  }
  assert.match(html, /property="og:image" content="https:\/\/kunlun7210.github.io\/luban\/icon-qu-512.png"/);
  assert.match(html, /name="twitter:image" content="https:\/\/kunlun7210.github.io\/luban\/icon-qu-512.png"/);
  assert.match(worker, /if \(cached\) return cached/);
});
