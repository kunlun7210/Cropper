// Public HTML only: discover brand assets without accounts/cookies or executing page scripts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const pages = process.argv.slice(2);
for (let i = 0; i < pages.length; i += 4) {
  await Promise.all(pages.slice(i, i + 4).map(async url => {
    try {
      const { stdout: html } = await run('curl', ['-L', '--compressed', '--max-time', '20', '-fsS', url], { maxBuffer: 6000000 });
      const matches = [...html.matchAll(/(?:src|href)=["']([^"']*(?:logo|icon|brand)[^"']*)/ig)].slice(0, 24).map(m => m[1]);
      const css = [...html.matchAll(/(?:src|href)=["']([^"']+\.css[^"']*)/ig)].slice(0, 6).map(m => m[1]);
      const media = [...html.matchAll(/\{"icon":"([^"]+)","title":"([^"]+)"[^}]+/g)].filter(m => ['美团标识', '大众点评标识'].includes(m[2])).map(m => ({ title: m[2], value: m[0] }));
      const contexts = [...html.matchAll(/.{0,70}logo.{0,130}/ig)].slice(0, 16).map(m => m[0]);
      const cssImages = [...html.matchAll(/url\(["']?([^)'"\s]+)["']?\)/ig)].filter(m => !m[1].startsWith('data:')).slice(0, 18).map(m => m[1]);
      const images = [...html.matchAll(/<img[^>]+>/ig)].slice(0, 15).map(m => m[0].replace(/data:[^"']+/g, 'data:[embedded image]'));
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)/ig)].slice(0, 12).map(m => m[1]);
      console.log(JSON.stringify({ url, bytes: html.length, matches, css, media, contexts, cssImages, images, scripts }));
    } catch (error) { console.log(JSON.stringify({ url, error: error.message })); }
  }));
}
