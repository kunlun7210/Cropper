/* 看图界面中的清晰照片：颜色不限，须有界面与双边界证据。
 * 不改变近黑判据，不对普通照片按色块裁剪，不使用样本坐标或文件名。 */
(function (root) {
  const average = (rows, a, b, key) => {
    let sum = 0, count = 0;
    for (let y = Math.max(0, Math.ceil(a)); y < Math.min(rows.length, b); y++) { sum += rows[y]?.[key] || 0; count++; }
    return count ? sum / count : Infinity;
  };
  function inspect(profile) {
    const { width: w, height: h, pixels: p } = profile;
    if (!p || w < 180 || h / w < 1.5 || h / w > 2.8) return null;
    // 两侧状态栏的细字/图形，再加导航标签或中间的应用胶囊。
    // 只用局部高频笔画，不限定文字颜色，也不把平坦天空当成界面。
    function ink(a, b, start, end) {
      let count = 0, total = 0;
      for (let y = Math.floor(h * start); y < h * end; y++) for (let x = Math.ceil(w * a); x < w * b; x++) {
        let edge = 0;
        for (let c = 0; c < 3; c++) edge += Math.abs(p[(y * w + x - 2) * 4 + c] + p[(y * w + x + 2) * 4 + c] - 2 * p[(y * w + x) * 4 + c]) / 3;
        if (edge > 30) count++;
        total++;
      }
      return count / Math.max(1, total);
    }
    const ui = { clock: ink(.09, .28, .018, .05), signal: ink(.70, .93, .018, .05), navigation: ink(.03, .97, .065, .11), capsule: ink(.37, .64, .014, .05),
      quietStatus: Math.max(ink(.09, .28, .005, .018), ink(.70, .93, .005, .018), ink(.09, .28, .05, .062), ink(.70, .93, .05, .062)) };
    const context = ui.clock > .08 && ui.clock < .35 && ui.signal > .08 && ui.signal < .40 && ui.quietStatus < .025
      && (ui.navigation > .025 || ui.capsule > .035);
    if (!context) return { ui, context, candidates: [], best: null };
    const rows = Array.from({ length: h }, () => ({ jump: 0, coverage: 0, detail: 0, light: 0 }));
    for (let y = 3; y < h - 3; y++) {
      const bins = new Uint16Array(256);
      let coverage = 0, detail = 0, light = 0;
      for (let x = 0; x < w; x++) {
        let jump = 0, sharp = 0;
        for (let c = 0; c < 3; c++) {
          jump += Math.abs(p[((y - 2) * w + x) * 4 + c] - p[((y + 2) * w + x) * 4 + c]) / 3;
          if (x >= 2 && x < w - 2) sharp += Math.abs(p[(y * w + x - 2) * 4 + c] + p[(y * w + x + 2) * 4 + c] - 2 * p[(y * w + x) * 4 + c]) / 3;
        }
        const i = (y * w + x) * 4;
        light += Math.max(p[i], p[i + 1], p[i + 2]);
        bins[Math.min(255, Math.round(jump))]++;
        if (jump > 10) coverage++;
        detail += sharp;
      }
      let total = 0, median = 0;
      for (; median < 255; median++) { total += bins[median]; if (total > w / 2) break; }
      rows[y] = { jump: median, coverage: coverage / w, detail: detail / w, light: light / w };
    }
    const header = (Math.floor(h * .015) * w + Math.floor(w * .3)) * 4;
    const legacyBlack = Math.max(p[header], p[header + 1], p[header + 2]) < 120
      && average(rows, h * .14, h * .20, 'light') < 32 && average(rows, h * .78, h * .82, 'light') < 32;
    if (legacyBlack) return { ui, context, legacyBlack, candidates: [], best: null };
    // 背景可能带压缩颗粒，阈值相对本张图的安静留白，而非某个固定颜色。
    const quiet = (a, b) => {
      const values = rows.slice(Math.floor(h * a), Math.ceil(h * b)).map(r => r.detail).sort((a, b) => a - b);
      return values[Math.floor(values.length * .25)];
    };
    const upperNoise = quiet(.14, .20);
    const backgroundNoise = Math.max(.35, upperNoise, Math.min(quiet(.78, .82), upperNoise * 1.5));
    const candidates = [];
    for (let y = Math.ceil(h * .18); y < h * .84; y++) {
      const row = rows[y];
      if (row.jump < 12 || row.coverage < .65) continue;
      if (candidates.length && y - candidates.at(-1).y <= 5) {
        if (row.jump * row.coverage > candidates.at(-1).jump * candidates.at(-1).coverage) candidates[candidates.length - 1] = { y, ...row };
      } else candidates.push({ y, ...row });
    }
    let best = null;
    if (context) for (const top of candidates.filter(c => c.y < h * .47)) for (const bottom of candidates.filter(c => c.y > h * .53)) {
      const height = bottom.y - top.y;
      if (height < h * .19 || height > h * .58 || Math.abs((top.y + bottom.y) / 2 - h * .5) > h * .10) continue;
      const before = average(rows, top.y - h * .055, top.y - 6, 'detail');
      const after = average(rows, bottom.y + 6, bottom.y + h * .055, 'detail');
      const inside = average(rows, top.y + 6, bottom.y - 6, 'detail');
      if (Math.max(before, after) > Math.min(6, backgroundNoise * 1.6 + .25) || inside < 3.5 || inside < Math.max(before, after) * 3) continue;
      // 内部楼层/桌面横线即使很亮，其外侧仍是清晰照片，会被上面的检验否决。
      const score = top.jump * top.coverage + bottom.jump * bottom.coverage + Math.min(inside, 25) * 2;
      // 多个边界都通过背景校验时优先保留更完整的清晰矩形。
      // 楼层/台阶可能比真正照片边缘更亮，不能只取最强横线。
      if (!best || height > best.height + 4 || (Math.abs(height - best.height) <= 4 && score > best.score))
        best = { top: top.y, bottom: bottom.y, height, before, after, inside, score };
    }
    return { ui, context, backgroundNoise, candidates, best };
  }
  function analyze(profile) {
    const result = inspect(profile);
    if (!result?.best) return null;
    const { top, bottom, score } = result.best;
    return { photo: { left: 0, right: profile.width, top, bottom }, score, kind: 'viewer-backdrop' };
  }
  const api = { analyze, inspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrameDetector = api;
})(globalThis);
