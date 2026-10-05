// Public UI glyph stencils only; never store a user's photo or author name.
// High-pass correlation recognizes translucent marks on light/dark photos.
(function (scope) {
  "use strict";
  const MASKS = {
  "amapCompact": [
    "001111111111100111000000000000000000000000000000000000000000",
    "011111111111100111100000000000000000000000000000000000000000",
    "011111111111100111100000000000000000000000000000000000000000",
    "011111111111100000100001111111000001111000101010000001000000",
    "111111111111100000100001000000000100100100100000000010001000",
    "000011100010000000000001111111000001111100100000000001110000",
    "000011100000000000000001000000001000000000100000000000000000",
    "011111000000000001100000111110100000000000100000100000000000",
    "011100000001000001100000100000000000100100100000000011110000",
    "110000000010000011100000000000000000000000100000000000000000",
    "111000000100000011100000000000000000000000000000000000000000",
    "111110001000000011100000000000000000000000000000000000000000",
    "111111110000000011100001010001010000101000000100000100111100",
    "111111100000000111100000000001000000100000000000010000000000",
    "011111100100000111100001110001000011101110000110001100000000",
    "011111101110000111100000000000000000000000000000000000000000",
    "001111111111000111000000000000000000000000000000000000000000",
    "000111111111000110000000000000000000000000000000000000000000"
  ],
  "elong": [
    "0111000000000000000000000000000000000000000000",
    "0001111000000000000000000011000110000010000000",
    "0000111110000001100000000111111110000111001110",
    "0011111100000000011000000000000000000011000000",
    "0001111100000000001100000000001110000011100000",
    "0000001110001110000110000000011110000011110100",
    "0000000111000011000111000000111000000110111100",
    "0000000111000001100011000001100000000110111000",
    "0110001011100000110011000011000001000100110000",
    "1110001001110000110011000011111111001100111110",
    "0110001100111000110011000000000000000000000000",
    "0110001100000000000011000000010000000000000000",
    "0111000110000000000011000010010000100001000010",
    "0011000111000000000110000101010001011111101010",
    "0001100001100000001100000100011001011100101100",
    "0000110000000000110000000111011101110100101100",
    "0000011000000000000000000000000000000000001010",
    "0000000000000000000000000000000000000000001010"
  ],
  "amap": [
    "000000000000000000000000000000000000000000000000000000",
    "011111111111000010111111100001000100100000111111111110",
    "000000000000000100000110000001001111111100100000000001",
    "011111111111001000111111110011101100100100101111111001",
    "100000000001000010101001010001000100100100101000001001",
    "011111111110000100111111110001000100100100100011111001",
    "011111111110001100000000000001000100100100100010011001",
    "110000000011000100111111110001000100100100100000001001",
    "100000000001000100000000000001000100100100100111110001",
    "101000000101000100101010000001000100000000100111111001",
    "101111111101000100101000010001000100000000100000000001",
    "100000000011000100001111000011110111111100111111111110",
    "111000000000000000000000000000000000000000000000000000"
  ]
};
  function highPass(values, w, h, radius = 2) {
    const stride = w + 1, integral = new Float64Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += values[y * w + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
      }
    }
    const result = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1]
        - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      result[y * w + x] = values[y * w + x] - sum / ((x1 - x0) * (y1 - y0));
    }
    return result;
  }
  function template(mask, width, height) {
    const values = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(mask[0].length - 1, (x + 0.5) / width * mask[0].length - 0.5));
      const sy = Math.max(0, Math.min(mask.length - 1, (y + 0.5) / height * mask.length - 0.5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), dx = sx - x0, dy = sy - y0;
      const x1 = Math.min(mask[0].length - 1, x0 + 1), y1 = Math.min(mask.length - 1, y0 + 1);
      values[y * width + x] = ((Number(mask[y0][x0]) * (1 - dx) + Number(mask[y0][x1]) * dx) * (1 - dy)
        + (Number(mask[y1][x0]) * (1 - dx) + Number(mask[y1][x1]) * dx) * dy) * 255;
    }
    const features = highPass(values, width, height);
    const points = [];
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++)
      if (Math.abs(features[y * width + x]) > 15) points.push({ x, y, value: features[y * width + x] });
    const probes = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 32)) === 0);
    return { points, probes };
  }
  function find(profile, photoEnd, heartMask, debug = false) {
    const { width: w, height: h, pixels } = profile;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3;
    const detail = highPass(gray, w, h);
    function score(points, x, y) {
      let dot = 0, a = 0, b = 0;
      for (const point of points) {
        const v = detail[(y + point.y) * w + x + point.x];
        dot += point.value * v; a += point.value * point.value; b += v * v;
      }
      return b > points.length * 4 ? dot / Math.sqrt(a * b) : 0;
    }
    const best = [];
    for (const [kind, mask, fraction, threshold, whole = false] of [
      ["amap", MASKS.amap, 0.1174, 0.58], ["elong", MASKS.elong, 0.10, 0.58],
      // Compact model includes the full arrow and text. Its stricter cutoff
      // still permits the subpixel changes caused by resize/JPEG decoding.
      ["amap", MASKS.amapCompact, 0.1304, 0.65, true],
      ["heart", heartMask, 0.046, 0.63],
    ]) {
      let match = { kind, score: 0 };
      const baseWidth = Math.round(w * fraction);
      const widths = new Set([
        ...[-2, -1, 0, 1, 2].map(delta => baseWidth + delta),
        ...[0.85, 0.925, 1.075, 1.125, 1.20, 1.30].map(scale => Math.round(baseWidth * scale)),
      ]);
      for (const width of widths) {
        const baseHeight = Math.round(width * mask.length / mask[0].length * (kind === "heart" ? 0.87 : 1));
        for (const delta of kind === "elong" ? [-1, 0, 1, 2] : whole ? [-1, 0, 1] : [0]) {
          const height = Math.max(6, baseHeight + delta);
          const { points, probes } = template(mask, width, height);
          const ymin = Math.max(Math.floor(h * 0.50), photoEnd - Math.ceil(w * 0.16));
          const ymax = Math.min(h - height, photoEnd + (kind === "heart" ? Math.round(w * 0.02) : 0));
          for (let y = ymin; y <= ymax; y++) for (let x = Math.floor(w * 0.77); x <= w - width - 1; x++) {
            if (score(probes, x, y) < 0.40) continue;
            const confidence = score(points, x, y);
            if (confidence > match.score) match = { kind, x, y, width, height, score: confidence };
          }
        }
      }
      // The map word sits to the right of a taller arrow logo. Return a box
      // covering BOTH, not just the detected text. eLong mask includes its logo.
      if (match.kind === "amap" && !whole && match.score >= threshold) {
        match.y -= Math.ceil(w * 0.013);
        match.x -= Math.ceil(w * 0.070);
        match.height += Math.ceil(w * 0.04);
        match.width += Math.ceil(w * 0.070);
      }
      if (debug || match.score >= threshold) best.push(match);
    }
    return best;
  }
  scope.ViewerMarks = { find };
  if (typeof module !== "undefined" && module.exports) module.exports = scope.ViewerMarks;
})(typeof window !== "undefined" ? window : globalThis);
