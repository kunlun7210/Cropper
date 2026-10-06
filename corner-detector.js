/* 四角策略与品牌词表独立于 OCR 引擎；不对整张照片做文字搜索。 */
(function (root) {
  const brands = [
    { id: 'amap', name: '高德地图', aliases: ['高德地图', 'AMAP', 'AMAP.COM'] },
    { id: 'baidu', name: '百度地图', aliases: ['百度地图', 'BAIDU地图', 'BAIDUMAP', 'BAIDUMAPS', 'MAP.BAIDU.COM'] },
    { id: 'tencent', name: '腾讯地图', aliases: ['腾讯地图', 'TENCENTMAP', 'TENCENTMAPS', 'MAP.QQ.COM'] },
    { id: 'elong', name: '艺龙', aliases: ['艺龙', '艺龙旅行', 'ELONG', 'ELONG.COM'] },
    { id: 'ctrip', name: '携程', aliases: ['携程', '携程旅行', 'CTRIP', 'CTRIP.COM', 'TRIP.COM'] },
    { id: 'tongcheng', name: '同程', aliases: ['同程', '同程旅行', '同程旅游', 'LY.COM'] },
    { id: 'dianping', name: '大众点评', aliases: ['大众点评', 'DIANPING', 'DIANPING.COM'] },
    { id: 'meituan', name: '美团', aliases: ['美团', 'MEITUAN', 'MEITUAN.COM'] },
    { id: 'fliggy', name: '飞猪', aliases: ['飞猪', '飞猪旅行', 'FLIGGY', 'FLIGGY.COM'] },
    { id: 'qunar', name: '去哪儿', aliases: ['去哪儿', '去哪儿网', '去哪儿旅行', 'QUNAR', 'QUNAR.COM'] },
    { id: 'taobao', name: '淘宝', aliases: ['淘宝', '淘宝网', 'TAOBAO', 'TAOBAO.COM'] },
  ];
  const normalize = text => String(text).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase();
  function brandFor(text) {
    const key = normalize(text);
    return brands.find(brand => brand.aliases.some(alias => normalize(alias) === key)) || null;
  }
  function approximateBrandFor(text) {
    const key = normalize(text);
    if (key.length < 4) return null;
    const distance = (a, b) => {
      let row = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 0; i < a.length; i++) {
        const next = [i + 1];
        for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
        row = next;
      }
      return row[b.length];
    };
    const matches = brands.filter(brand => brand.aliases.some(alias => {
      const target = normalize(alias);
      return target.length >= 4 && Math.abs(target.length - key.length) <= 1 && distance(key, target) === 1;
    }));
    return matches.length === 1 ? matches[0] : null;
  }
  function combineItems(items) {
    const out = [...items];
    const bounds = item => {
      const x = item.poly.map(p => p[0]), y = item.poly.map(p => p[1]);
      return { x0: Math.min(...x), x1: Math.max(...x), y0: Math.min(...y), y1: Math.max(...y) };
    };
    for (const left of items) for (const right of items) {
      if (left === right || !left.poly?.length || !right.poly?.length) continue;
      const a = bounds(left), b = bounds(right), h = Math.max(a.y1 - a.y0, b.y1 - b.y0);
      if (b.x0 < a.x1 - h * .2 || b.x0 - a.x1 > h * 2 || Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2) > h * .5) continue;
      const joined = String(left.text) + String(right.text);
      const baiduSplit = /^BAIDUT?$/i.test(normalize(left.text)) && normalize(right.text) === '地图';
      if (!brandFor(joined) && !approximateBrandFor(joined) && !baiduSplit) continue;
      const x0 = Math.min(a.x0, b.x0), x1 = Math.max(a.x1, b.x1), y0 = Math.min(a.y0, b.y0), y1 = Math.max(a.y1, b.y1);
      out.push({ text: baiduSplit ? '百度地图' : joined, score: Math.min(left.score, right.score), poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], needsTemplate: baiduSplit || !brandFor(joined) });
    }
    return out;
  }
  function corners(photo) {
    const w = photo.right - photo.left, h = photo.bottom - photo.top;
    if (w < 160 || h < 100) return [];
    const width = Math.round(Math.min(w * .38, 720));
    const height = Math.round(Math.min(h * .25, w * .22, 360));
    return [
      { x: photo.left, y: photo.top, width, height, side: 'top', corner: 'top-left' },
      { x: photo.right - width, y: photo.top, width, height, side: 'top', corner: 'top-right' },
      { x: photo.left, y: photo.bottom - height, width, height, side: 'bottom', corner: 'bottom-left' },
      { x: photo.right - width, y: photo.bottom - height, width, height, side: 'bottom', corner: 'bottom-right' },
    ];
  }
  // 用文字锚点寻找旁边的小型高对比 logo；大块照片纹理不能成为 logo。
  function logoBounds(box, pixels, width, height) {
    const unit = Math.max(8, box.height);
    const x0 = Math.max(0, Math.floor(box.x - unit * 3));
    const x1 = Math.min(width, Math.ceil(box.x + box.width + unit * 3));
    const y0 = Math.max(0, Math.floor(box.y - unit * 1.4));
    const y1 = Math.min(height, Math.ceil(box.y + box.height + unit * 1.4));
    const seen = new Uint8Array((x1 - x0) * (y1 - y0));
    const stride = x1 - x0;
    const foreground = (x, y) => {
      const i = (y * width + x) * 4;
      const hi = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const lo = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      return hi > 215 && (hi - lo < 65 || hi - lo > 100);
    };
    let left = box.x, top = box.y, right = box.x + box.width, bottom = box.y + box.height;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const start = (y - y0) * stride + x - x0;
      if (seen[start]) continue;
      seen[start] = 1;
      if (!foreground(x, y)) continue;
      const queue = [[x, y]];
      let ax = x, bx = x, ay = y, by = y;
      for (let q = 0; q < queue.length; q++) {
        const [px, py] = queue[q];
        ax = Math.min(ax, px); bx = Math.max(bx, px); ay = Math.min(ay, py); by = Math.max(by, py);
        for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const k = (ny - y0) * stride + nx - x0;
          if (seen[k]) continue;
          seen[k] = 1;
          if (foreground(nx, ny)) queue.push([nx, ny]);
        }
      }
      const cw = bx - ax + 1, ch = by - ay + 1;
      const gap = Math.max(box.x - bx, ax - (box.x + box.width), 0);
      const overlaps = by >= box.y - unit * .8 && ay <= box.y + box.height + unit * .8;
      if (queue.length >= 8 && cw <= unit * 2.8 && ch <= unit * 2.8 && gap <= unit * 1.8 && overlaps
          && ax > x0 && bx < x1 - 1 && ay > y0 && by < y1 - 1) {
        left = Math.min(left, ax); right = Math.max(right, bx + 1);
        top = Math.min(top, ay); bottom = Math.max(bottom, by + 1);
      }
    }
    const pad = Math.max(2, Math.min(8, Math.ceil(unit * .35)));
    return { x: left - pad, y: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
  }
  function highPass(values, width, height) {
    const out = new Float32Array(values.length);
    const integral = new Float64Array((width + 1) * (height + 1)), stride = width + 1;
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) { sum += values[y * width + x]; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum; }
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 2), x1 = Math.min(width, x + 3), y0 = Math.max(0, y - 2), y1 = Math.min(height, y + 3);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      out[y * width + x] = values[y * width + x] - sum / ((x1 - x0) * (y1 - y0));
    }
    return out;
  }
  // 同品牌文字锚点附近的定向模板匹配；不以 logo 模板盲扫整张照片。
  function templateBounds(box, pixels, width, height, template) {
    if (!template?.rgba) return null;
    const original = Uint8Array.from(atob(template.rgba), char => char.charCodeAt(0));
    const gray = new Float32Array(width * height);
    let background = 0;
    for (let i = 0; i < gray.length; i++) { gray[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3; background += gray[i]; }
    background /= gray.length;
    const detail = highPass(gray, width, height);
    let best = null;
    for (let th = Math.max(8, Math.floor(box.height * .8)); th <= Math.min(height, box.height * 3.8); th++) {
      const tw = Math.round(th * template.width / template.height);
      if (th < 8 || th > height || tw > width || tw < box.width * .75) continue;
      const x0 = Math.max(0, Math.floor(box.x - Math.min(tw, box.height * 4)));
      const x1 = Math.min(width - tw, Math.ceil(box.x + box.width * .3));
      const y0 = Math.max(0, Math.floor(box.y - th));
      const y1 = Math.min(height - th, Math.ceil(box.y + box.height * .35));
      for (const style of ['original', 'white', 'black']) {
        const values = new Float32Array(tw * th);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
          const sx = Math.max(0, Math.min(template.width - 1, (x + .5) / tw * template.width - .5));
          const sy = Math.max(0, Math.min(template.height - 1, (y + .5) / th * template.height - .5));
          const ax = Math.floor(sx), ay = Math.floor(sy), dx = sx - ax, dy = sy - ay;
          let value = 0;
          for (const [px, py, weight] of [[ax, ay, (1 - dx) * (1 - dy)], [Math.min(ax + 1, template.width - 1), ay, dx * (1 - dy)], [ax, Math.min(ay + 1, template.height - 1), (1 - dx) * dy], [Math.min(ax + 1, template.width - 1), Math.min(ay + 1, template.height - 1), dx * dy]]) {
            const i = (py * template.width + px) * 4, alpha = original[i + 3] / 255;
            const fg = style === 'white' ? 255 : style === 'black' ? 0 : (original[i] + original[i + 1] + original[i + 2]) / 3;
            value += (background * (1 - alpha) + fg * alpha) * weight;
          }
          values[y * tw + x] = value;
        }
        const pattern = highPass(values, tw, th), points = [];
        for (let y = 1; y < th - 1; y++) for (let x = 1; x < tw - 1; x++) if (Math.abs(pattern[y * tw + x]) > 10) points.push({ x, y, value: pattern[y * tw + x] });
        if (points.length < 32) continue;
        const probes = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 48)) === 0);
        const score = (list, x, y) => {
          let dot = 0, a = 0, b = 0;
          for (const p of list) { const v = detail[(y + p.y) * width + x + p.x]; dot += p.value * v; a += p.value ** 2; b += v ** 2; }
          return b > list.length * 12 ? dot / Math.sqrt(a * b) : 0;
        };
        for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
          if (score(probes, x, y) < .6) continue;
          const confidence = score(points, x, y);
          if (confidence < .68) continue;
          // 粗网格之后补一像素对齐，避免小字在缩放后因奇偶坐标漏匹配。
          for (let ry = Math.max(y0, y - 1); ry <= Math.min(y1, y + 1); ry++) for (let rx = Math.max(x0, x - 1); rx <= Math.min(x1, x + 1); rx++) {
            const refined = score(points, rx, ry);
            if (refined >= .8 && (!best || refined > best.score)) best = { x: rx, y: ry, width: tw, height: th, score: refined };
          }
        }
      }
    }
    if (!best) return null;
    const pad = Math.max(2, Math.min(8, Math.ceil(box.height * .2)));
    return { x: best.x - pad, y: best.y - pad, width: best.width + pad * 2, height: best.height + pad * 2, templateScore: best.score };
  }
  function accept(result, roi, photo, pixels, templates = []) {
    const exact = brandFor(result.text), brand = exact || approximateBrandFor(result.text);
    if (!brand || Number(result.score) < .82 || !Array.isArray(result.poly) || result.poly.length < 4) return null;
    const xs = result.poly.map(p => p[0]), ys = result.poly.map(p => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (!Object.values(box).every(Number.isFinite) || box.height < 5 || box.height > (photo.right - photo.left) * .065
        || box.width < box.height || box.width > (photo.right - photo.left) * .34) return null;
    // 必须紧贴主体角落，且最多损失主体高度的 12%；主体里的招牌不裁。
    const matched = pixels ? templateBounds(box, pixels, roi.width, roi.height, templates.find(t => t.id === brand.id)) : null;
    // 长品牌名仅容许单字 OCR 误差，还必须有更强的同品牌完整 logo 证据。
    if ((result.needsTemplate || !exact) && (!matched || matched.templateScore < .86)) return null;
    const expanded = matched || (pixels ? logoBounds(box, pixels, roi.width, roi.height) : box);
    const mark = { ...expanded, x: expanded.x + roi.x, y: expanded.y + roi.y, kind: brand.id, name: brand.name, side: roi.side, score: result.score };
    const cut = roi.side === 'bottom' ? mark.y : mark.y + mark.height;
    const loss = roi.side === 'bottom' ? photo.bottom - cut : cut - photo.top;
    const edgeGap = roi.corner.endsWith('right') ? photo.right - (box.x + roi.x + box.width) : box.x + roi.x - photo.left;
    if (loss <= 0 || loss > (photo.bottom - photo.top) * .12 || edgeGap > (photo.right - photo.left) * .065) return null;
    return mark;
  }
  function merge(detected, marks, image, sides) {
    const out = { ...detected };
    for (const mark of marks) {
      if (!sides[mark.side]) continue;
      const amount = mark.side === 'bottom' ? image.height - Math.floor(mark.y) : Math.ceil(mark.y + mark.height);
      out[mark.side] = Math.max(out[mark.side], amount);
    }
    return out;
  }
  const api = { brands, brandFor, approximateBrandFor, combineItems, corners, logoBounds, templateBounds, accept, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CornerDetector = api;
})(globalThis);
