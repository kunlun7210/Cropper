// Targeted UI recognition, not general OCR. Masks contain only public UI
// glyphs (a heart and 高德); no photos, names or fixed screenshot coordinates.
(function (scope) {
  "use strict";
  const HEART = [
    "000011111100001111110000", "001111111110011111111100",
    "011110001111111100011110", "011000000011110000001110",
    "111000000001100000000111", "110000000000000000000011",
    "110000000000000000000011", "110000000000000000000011",
    "110000000000000000000011", "110000000000000000000011",
    "111000000000000000000111", "011000000000000000000110",
    "011100000000000000001110", "001100000000000000001100",
    "001110000000000000011100", "000111000000000000111000",
    "000011100000000001110000", "000001110000000011100000",
    "000000111000000111100000", "000000011100001111000000",
    "000000011110011110000000", "000000001111111100000000",
    "000000000111111000000000", "000000000001100000000000",
  ];
  const AMAP = [
    "0000000011000000000000001000000011000000",
    "0000000011000000000000001100000011100010",
    "1111111111111111110000011001111111111110",
    "1111111111111111110000011000000011000000",
    "0000000000000000000000110000000010000000",
    "0000000000000000000001100000111111111110",
    "0001111111111110000001100000111111111110",
    "0001100000000110000001000100100100100110",
    "0001100000000110000000000100100100100110",
    "0001111111111110000000001100100100100110",
    "0000100000000110000000011000111111111110",
    "0000000000000000000000011000100000000100",
    "0111111111111111100000111000000000000000",
    "0111111111111111100001111000111111111110",
    "0110000000000000100001011001111111111110",
    "0100000000000000100000011000000000000000",
    "0100011111111000100000011000000000000000",
    "0100011000001000100000011001001001100110",
    "0100010000001000100000011001001000100010",
    "0100011000011000100000011001001000000010",
    "0100011111111000100000011001001000001011",
    "0100000000000001100000011011001100011001",
    "0100000000000111100000011000001111111000",
    "0100000000000111000000011000000111110000",
  ];

  function analyze(profile) {
    const { width: w, height: h, pixels } = profile;
    if (!pixels || w < 180 || h / w < 1.35 || h / w > 2.8) return null;
    const white = new Uint8Array(w * h);
    const dark = new Uint8Array(w * h);
    const rows = Array.from({ length: h }, () => ({ darkRatio: 0 }));
    for (let i = 0; i < white.length; i++) {
      const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
      white[i] = Math.min(r, g, b) >= 230 && Math.max(r, g, b) - Math.min(r, g, b) < 25 ? 1 : 0;
      dark[i] = Math.max(r, g, b) < 32 ? 1 : 0;
      rows[Math.floor(i / w)].darkRatio += dark[i] / w;
    }

    // The toolbar identifies the viewer even when the photo touches it and
    // the lower toolbar is translucent. Black letterboxing is optional.
    const toolbarTop = Math.floor(h * 0.065), gapStart = Math.ceil(h * 0.12);
    function whiteCount(x0, x1, y0, y1) {
      let count = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) count += white[y * w + x];
      return count;
    }
    if ([[0.035, 0.13], [0.43, 0.61], [0.84, 0.98]].some(([a, b]) =>
      whiteCount(w * a, w * b, toolbarTop, gapStart) < w * w * 0.00012)) return null;
    let uniform = 0, total = 0;
    const sample = (Math.floor(h * 0.03) * w + Math.floor(w * 0.28)) * 4;
    const background = [pixels[sample], pixels[sample + 1], pixels[sample + 2]];
    if (Math.max(...background) < 28 || Math.max(...background) > 100) return null;
    for (let y = Math.floor(h * 0.015); y < h * 0.07; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (background.every((v, channel) => Math.abs(pixels[i + channel] - v) <= 12)) uniform++;
      total++;
    }
    if (uniform / total < 0.72) return null;
    let gapEnd = -1;
    for (let y = Math.floor(h * 0.09); y < h * 0.16; y++) {
      let similar = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (background.every((v, channel) => Math.abs(pixels[i + channel] - v) <= 35)) similar++;
      }
      if (similar / w < 0.65) { gapEnd = y; break; }
    }
    if (gapEnd < 0) return null;
    const touchingToolbar = rows[gapEnd].darkRatio < 0.985;
    while (gapEnd < h * 0.46 && rows[gapEnd].darkRatio >= 0.985) gapEnd++;

    function similarity(box, template) {
      let ink = 0, inkMatch = 0, blank = 0, blankMatch = 0;
      for (let y = 0; y < template.length; y++) for (let x = 0; x < template[0].length; x++) {
        const sx = Math.min(w - 1, box.x + Math.floor((x + 0.5) * box.width / template[0].length));
        const sy = Math.min(h - 1, box.y + Math.floor((y + 0.5) * box.height / template.length));
        const actual = white[sy * w + sx];
        if (template[y][x] === "1") {
          // Allow a one-pixel stroke displacement from resizing/antialiasing.
          // Empty-space scoring remains exact, so solid shapes do not match.
          let near = actual;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (sx + dx >= box.x && sx + dx < box.x + box.width && sy + dy >= box.y && sy + dy < box.y + box.height)
              near = Math.max(near, white[(sy + dy) * w + sx + dx]);
          }
          ink++; inkMatch += near;
        }
        else { blank++; blankMatch += 1 - actual; }
      }
      return { ink: inkMatch / ink, blank: blankMatch / blank };
    }

    // Connected white strokes localize the outline heart at any vertical
    // position in the lower portion. Its interior/background also must match.
    const visited = new Uint8Array(w * h);
    let heart = null;
    for (let y = Math.floor(h * 0.55); y < h * 0.93; y++) for (let x = Math.floor(w * 0.77); x < w * 0.98; x++) {
      const start = y * w + x;
      if (!white[start] || visited[start]) continue;
      const queue = [start]; visited[start] = 1;
      let xmin = x, xmax = x, ymin = y, ymax = y;
      for (let k = 0; k < queue.length; k++) {
        const p = queue[k], px = p % w, py = Math.floor(p / w);
        xmin = Math.min(xmin, px); xmax = Math.max(xmax, px);
        ymin = Math.min(ymin, py); ymax = Math.max(ymax, py);
        // Bridge a one-pixel break introduced by downsampling thin outlines.
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < w * 0.74 || nx >= w || ny < h * 0.52 || ny >= h * 0.95) continue;
          const next = ny * w + nx;
          if (white[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
        }
      }
      const box = { x: xmin, y: ymin, width: xmax - xmin + 1, height: ymax - ymin + 1 };
      if (box.width < w * 0.025 || box.width > w * 0.075 || box.height < w * 0.022 || box.height > w * 0.075) continue;
      if (box.width / box.height < 0.95 || box.width / box.height > 1.35) continue;
      const score = similarity(box, HEART);
      if (score.ink >= 0.80 && score.blank >= 0.90 && (!heart || box.y > heart.y)) heart = box;
    }

    // Author rows are short white text on a predominantly black footer.
    // Recognize 高德 when available, but also allow other author names when
    // the toolbar AND outline heart have independently identified the viewer.
    const authorBands = [];
    let amap = null;
    for (let y = Math.floor(h * 0.66); y < h * 0.95; y++) {
      if (rows[y].darkRatio < 0.65 || whiteCount(w * 0.135, w * 0.7, y, y + 1) < 2) continue;
      const start = y;
      while (y < h * 0.95 && rows[y].darkRatio >= 0.65 && whiteCount(w * 0.135, w * 0.7, y, y + 1) >= 2) y++;
      const height = y - start;
      if (height < w * 0.018 || height > w * 0.055) continue;
      const band = { y: start, height };
      authorBands.push(band);
      const width = Math.round(height * 77 / 37);
      for (let x = Math.floor(w * 0.12); x < w * 0.5; x++) {
        const score = similarity({ x, y: start, width, height }, AMAP);
        if (score.ink >= 0.94 && score.blank >= 0.80) { amap = band; break; }
      }
    }
    // Estimate the photo's lower edge from a sustained image band. Sparse
    // author/date/footer rows cannot masquerade as the photo.
    let bandEnd = -1, run = 0;
    for (let y = h - 1; y > Math.max(gapEnd + h * 0.18, h * 0.5); y--) {
      if (rows[y].darkRatio < 0.65) {
        if (!run) bandEnd = y + 1;
        if (++run >= Math.max(8, Math.ceil(h * 0.008))) break;
      } else { run = 0; bandEnd = -1; }
    }
    const marks = typeof ViewerMarks !== "undefined" && bandEnd > 0
      ? ViewerMarks.find(profile, bandEnd, HEART) : [];
    const scannedHeart = marks.find(mark => mark.kind === "heart");
    if (!heart && scannedHeart) heart = scannedHeart;
    if (!heart && !amap && !marks.length) return null;
    const exclusions = authorBands.filter((band) => amap === band || (heart && band.y > heart.y + heart.height))
      .map((band) => ({ x0: w * 0.015, x1: w * 0.74, y0: band.y - w * 0.045, y1: band.y + band.height + w * 0.045 }));
    if (heart) exclusions.push({ x0: heart.x - w * 0.008, x1: w, y0: heart.y - w * 0.01, y1: heart.y + heart.height + w * 0.01 });
    let photoEnd = h;
    for (let y = h - 1; y > Math.max(gapEnd + h * 0.18, h * 0.5); y--) {
      // Older viewer footers can include a publish date, description and
      // details link. After the like control, sparse rows on black belong
      // to this footer too; do not stop the crop at a later label.
      if (heart && y > heart.y + heart.height + w * 0.025 && rows[y].darkRatio >= 0.65) {
        photoEnd = y;
        continue;
      }
      let count = 0, black = 0;
      for (let x = 0; x < w; x++) {
        if (exclusions.some((box) => y >= box.y0 && y <= box.y1 && x >= box.x0 && x < box.x1)) continue;
        count++; black += dark[y * w + x];
      }
      if (count < w * 0.18 || black / count < 0.985) { photoEnd = y + 1; break; }
      photoEnd = y;
    }
    if (h - photoEnd < h * 0.04 || photoEnd - gapEnd < h * 0.18) return null;
    if (bandEnd > 0 && photoEnd > bandEnd + h * 0.03) photoEnd = bandEnd;
    // If the heart overlays the photo, remove its full-width strip with a
    // small glyph-sized safety gap. If it sits in black padding, lose no photo.
    const overlay = heart && heart.y < photoEnd && heart.y > photoEnd - w * 0.30;
    let bottom = overlay ? Math.min(photoEnd, heart.y - Math.max(2, Math.round(heart.height * 0.40))) : photoEnd;
    for (const mark of marks.filter(mark => mark.kind !== "heart"))
      bottom = Math.min(bottom, mark.y - Math.max(2, Math.ceil(w * 0.006)));
    // A visible author row and its taller avatar can themselves overlay the
    // photo (no black footer). Remove the whole row, including the avatar.
    if (heart && photoEnd - heart.y > w * 0.13) {
      const author = authorBands.find(band => band.y > heart.y);
      if (author) bottom = Math.min(bottom, author.y - Math.ceil(w * 0.04), heart.y - 3);
    }
    return { top: gapEnd, bottom: h - bottom, like: Boolean(heart),
      amap: Boolean(amap || marks.some(mark => mark.kind === "amap")),
      elong: marks.some(mark => mark.kind === "elong"), overlay: Boolean(overlay || bottom < photoEnd), touchingToolbar, marks };
  }
  scope.ViewerDetector = { analyze };
  if (typeof module !== "undefined" && module.exports) module.exports = scope.ViewerDetector;
})(typeof window !== "undefined" ? window : globalThis);
