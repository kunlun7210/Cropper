
const DEFAULTS = {
  darkThreshold: 42,
  coverage: 92,
  minThickness: 1,
  padding: 0,
  detectChrome: true,
  sides: { top: true, bottom: true, left: true, right: true },
};

// 待裁条带中"近黑行"的占比下限。它不是用来判定"是不是边框"的主判据
// （主判据是"中心段之外没有连续内容"），而是防止把画面里的小暗块误当
// 边框的低位保护：条带里近黑部分少于四分之一，说明这只是一小块暗色
// 物体，为了它切掉外侧真实内容不划算，此时不裁交给手动微调。
// 实测：真实截图里最"薄"的一条边框占比约 37%，留有余量。
const MIN_BORDER_PURITY = 0.25;
// 单边最多裁掉轴长的比例，作为"主体至少还要占 1/4"的兜底保护。
const MAX_CROP_RATIO = 0.75;

// ---------------------------------------------------------------------------
// 深色界面栏（UI chrome）识别参数
//
// 背景：在相册/社交 App 里看图时截图，画面顶部会带上应用自身的深色界面——
// 状态栏、"‹ 返回 / 页码 / 投诉"导航栏，以及照片上下的黑色留白。这类区域
// 的颜色是纯黑 (0,0,0) 或去饱和深板岩 (40,45,55)，最大通道 55。
// 默认黑色阈值 42 看不见它，于是整块界面被当成"内容"保留下来。
//
// 判据用"行中位数"而非"行均值"：界面栏是"暗底 + 少量白字"，白字会把
// 行均值抬到 73~78 并在阈值附近摆动，而行中位数稳定在 55~66；照片行的
// 中位数就是照片自身颜色，无法靠它蒙混。
// ---------------------------------------------------------------------------
const CHROME_MEDIAN = 72;        // 行主色（中位数）上限，超过即认为是照片内容
const FLAT_TOLERANCE = 12;       // 与行中位数相差多少以内算"同色"
const FLAT_FRACTION = 0.78;      // 同色像素占比下限：界面栏是纯色块，照片有纹理
const BRIGHT_LEVEL = 150;        // "亮像素"门槛，用于识别文字笔画
const BRIGHT_FRACTION = 0.10;    // 亮像素占比上限：界面栏上只有少量文字
const CHROME_MAX_GAP = 8;        // 游程内可容忍的连续间断行数（抗锯齿/渐变）
const CHROME_MIN_SLAB = 20;      // 界面栏游程长度下限（profile 行）
const CHROME_DENSITY = 0.80;     // 游程内"界面栏行"占比下限
const CHROME_CONTRAST_MIN = 100; // 界面栏之后首行的亮度下限
const CHROME_CONTRAST_RATIO = 1.6; // 或为界面栏亮度中位数的若干倍

const state = { items: [], settings: structuredClone(DEFAULTS) };
const $ = (id) => document.getElementById(id);
const results = $("results");
const batchActions = $("batchActions");

const controls = {
  darkThreshold: $("darkThreshold"),
  coverage: $("coverage"),
  minThickness: $("minThickness"),
  padding: $("padding"),
  detectChrome: $("detectChrome"),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function updateControlLabels() {
  $("darkThresholdValue").value = controls.darkThreshold.value;
  $("darkThresholdValue").textContent = controls.darkThreshold.value;
  $("coverageValue").textContent = `${controls.coverage.value}%`;
  $("minThicknessValue").textContent = `${Number(controls.minThickness.value).toFixed(1)}%`;
  $("paddingValue").textContent = `${controls.padding.value} px`;
}

function readSettings() {
  state.settings.darkThreshold = Number(controls.darkThreshold.value);
  state.settings.coverage = Number(controls.coverage.value);
  state.settings.minThickness = Number(controls.minThickness.value);
  state.settings.padding = Number(controls.padding.value);
  state.settings.detectChrome = controls.detectChrome.checked;
  document.querySelectorAll(".side-toggle").forEach((input) => {
    state.settings.sides[input.dataset.side] = input.checked;
  });
}

// 参数真正变化时才重算，避免同一个值反复触发整批重分析。
function applyChangedSettings() {
  const previous = JSON.stringify(state.settings);
  readSettings();
  if (previous !== JSON.stringify(state.settings)) reanalyzeAll();
}

function settingsInput() {
  updateControlLabels();
  if (state.items.length) $("status").textContent = "参数已调整，松开滑块后自动应用。";
}

function resetSettings() {
  controls.darkThreshold.value = DEFAULTS.darkThreshold;
  controls.coverage.value = DEFAULTS.coverage;
  controls.minThickness.value = DEFAULTS.minThickness;
  controls.padding.value = DEFAULTS.padding;
  controls.detectChrome.checked = DEFAULTS.detectChrome;
  document.querySelectorAll(".side-toggle").forEach((input) => {
    input.checked = DEFAULTS.sides[input.dataset.side];
  });
  updateControlLabels();
  readSettings();
  reanalyzeAll();
}

// 把一行（或一列）抽样点汇总成判定所需的特征。
//   darkRatio        近黑像素占比            —— 严格近黑判据用
//   meanMaxChannel   最大通道均值            —— 严格近黑判据用
//   medianMaxChannel 最大通道中位数          —— 界面栏判据用（抗白字干扰）
//   flatFraction     落在中位数 ±12 内的占比  —— 界面栏判据用（纯色块 → 高）
//   brightFraction   亮像素占比              —— 界面栏判据用（只有少量文字）
//
// 实现上用 256 桶直方图而不是对抽样点排序：
//   1. 最大通道的取值范围天生是 0~255，直方图是精确的，不是近似；
//   2. 中位数按"累计计数达到 count/2+1 的最小取值"取，与 sorted[floor(count/2)]
//      完全等价；±12 窗口占比与亮像素占比同样是窗口内计数；
//   3. 单行只需一次遍历 + 一次 256 步扫描，比排序快一个量级，
//      大规模图片（相册原图）在 iPhone 上也不会卡顿。
const histogram = new Uint16Array(256);

function profileLine(count, darkCount, total) {
  let cumulative = 0;
  const target = Math.floor(count / 2) + 1;
  let median = 0;
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value];
    if (cumulative >= target) {
      median = value;
      break;
    }
  }
  const low = Math.max(0, median - FLAT_TOLERANCE);
  const high = Math.min(255, median + FLAT_TOLERANCE);
  let flatCount = 0;
  for (let value = low; value <= high; value += 1) flatCount += histogram[value];
  let brightCount = 0;
  for (let value = BRIGHT_LEVEL; value < 256; value += 1) brightCount += histogram[value];
  return {
    darkRatio: darkCount / count,
    meanMaxChannel: total / count,
    medianMaxChannel: median,
    flatFraction: flatCount / count,
    brightFraction: brightCount / count,
  };
}

function createProfile(image, settings, maxDimension = 1000) {
  const ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 900));
  const rows = [];
  const columns = [];

  for (let y = 0; y < height; y += 1) {
    histogram.fill(0);
    let darkCount = 0;
    let total = 0;
    let count = 0;
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const maxChannel = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (maxChannel <= settings.darkThreshold) darkCount += 1;
      histogram[maxChannel] += 1;
      total += maxChannel;
      count += 1;
    }
    rows.push(profileLine(count, darkCount, total));
  }

  for (let x = 0; x < width; x += 1) {
    histogram.fill(0);
    let darkCount = 0;
    let total = 0;
    let count = 0;
    for (let y = 0; y < height; y += stride) {
      const index = (y * width + x) * 4;
      const maxChannel = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (maxChannel <= settings.darkThreshold) darkCount += 1;
      histogram[maxChannel] += 1;
      total += maxChannel;
      count += 1;
    }
    columns.push(profileLine(count, darkCount, total));
  }

  return { width, height, rows, columns };
}

// v1 判据：严格近黑。保留原样，保证纯黑边框的既有行为完全不变。
function nearBlack(line, settings) {
  // darkRatio prevents a single black patch from being treated as a full-width bar.
  // meanMaxChannel keeps a noisy dark-gray line from passing only on pixel count.
  const darkEnough = line.darkRatio >= settings.coverage / 100;
  const luminanceEnough = line.meanMaxChannel <= settings.darkThreshold * 1.18;
  return darkEnough && luminanceEnough;
}

// 界面栏单行判据：平坦深色。参数含义见文件顶部说明。
function chromeLine(line) {
  return line.medianMaxChannel <= CHROME_MEDIAN
    && line.flatFraction >= FLAT_FRACTION
    && line.brightFraction <= BRIGHT_FRACTION;
}

// 从边缘沿 order 方向扫出"界面栏游程"，返回应从该边裁掉的行数。
//
// 只承认从图像边缘起连续的界面栏：这样即使照片中部出现一条平坦暗带，
// 也不会被误判而把画布切碎。游程内允许 CHROME_MAX_GAP 行的间断（抗锯齿
// 过渡行、渐变），连续间断超过该值即判定已经进入照片内容。游程末端回退
// 到"最后一个界面栏行"之后，避免把照片内容一并吞掉。
function edgeSlab(profile, order, settings) {
  let lastChrome = -1;
  let gap = 0;

  for (let position = 0; position < order.length; position += 1) {
    const line = profile[order[position]];
    if (chromeLine(line)) {
      lastChrome = position;
      gap = 0;
    } else if (nearBlack(line, settings)) {
      // 纯黑留白本身也要裁掉，但它不构成"界面栏"证据。
      gap = 0;
    } else {
      gap += 1;
      if (gap > CHROME_MAX_GAP) break;
    }
  }

  if (lastChrome < 0) return 0;
  const length = lastChrome + 1;
  if (length < CHROME_MIN_SLAB || length >= profile.length) return 0;

  let chromeCount = 0;
  const runMeans = [];
  for (let i = 0; i < length; i += 1) {
    const line = profile[order[i]];
    if (chromeLine(line)) chromeCount += 1;
    runMeans.push(line.meanMaxChannel);
  }
  if (chromeCount / length < CHROME_DENSITY) return 0;

  // 对比度护栏：界面栏之后必须明显更亮，否则说明这只是照片自身的暗部，
  // 或者是"暗色照片 + 暗色背景"这种无法靠像素分辨的情形，保守放弃。
  runMeans.sort((a, b) => a - b);
  const runMedian = runMeans[Math.floor(runMeans.length / 2)];
  const needed = Math.max(CHROME_CONTRAST_MIN, runMedian * CHROME_CONTRAST_RATIO);
  if (profile[order[length]].meanMaxChannel < needed) return 0;

  return length;
}

// 把逐行/逐列剖面归约为「该行/列是否属于应从边缘裁掉的条带」。
// v1 的严格近黑与新增的贴边界面栏在此合并，后续机制（内容段、中心锚定
// 主体、纯度保护、上限保护）全部原样复用。
function borderMask(profile, settings) {
  const mask = profile.map((line) => nearBlack(line, settings));
  if (!settings.detectChrome || profile.length < CHROME_MIN_SLAB + 2) return mask;

  const order = profile.map((_, index) => index);
  const leading = edgeSlab(profile, order, settings);
  const trailing = edgeSlab(profile, order.slice().reverse(), settings);
  for (let i = 0; i < leading; i += 1) mask[i] = true;
  for (let i = 0; i < trailing; i += 1) mask[profile.length - 1 - i] = true;
  return mask;
}

// 把逐行/逐列剖面切成「待裁条带」与「内容段」，返回所有内容段的 [起, 止] 索引。
function contentBands(mask) {
  const bands = [];
  let start = null;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      if (start !== null) {
        bands.push([start, index - 1]);
        start = null;
      }
    } else if (start === null) {
      start = index;
    }
  }
  if (start !== null) bands.push([start, mask.length - 1]);
  return bands;
}

// 主体 = 包含图像几何中心的那一段连续内容。四条边的裁剪量就是从这个
// 中心段向上下左右量出去：凡是中心段之外没有连续内容的区域，一律裁掉。
//
// 如果中心本身就落在黑区里（例如"界面工具条 + 长条黑边"把中心包住的
// 截图，照片只占画面下半部分），说明「中心必在主体内」这个前提不成立，
// 此时退化为取最长的一段连续内容，仍然能得到正确的主体。旧版从中心向
// 外扫描时没有这个退化分支：起点已在黑区内，代码把中心误判成黑边的内侧
// 边缘，算出接近半个画布的裁剪量后被安全上限否掉，结果一边都不裁。
function subjectBand(mask) {
  const bands = contentBands(mask);
  if (!bands.length) return null;
  const center = Math.floor(mask.length / 2);
  const containing = bands.find((band) => center >= band[0] && center <= band[1]);
  if (containing) return containing;
  return bands.reduce((best, band) => (band[1] - band[0] > best[1] - best[0] ? band : best));
}

// 待裁条带里"属于边框"的行占多大比例。占比过低说明黑条夹在画面中间，
// 不该为了它切掉外侧内容，此时保留原样交给手动微调。
function borderPurity(mask, boundary, fromEdge) {
  const strip = fromEdge
    ? mask.slice(0, boundary)
    : mask.slice(mask.length - boundary);
  if (!strip.length) return 0;
  return strip.filter(Boolean).length / strip.length;
}

function detectSide(mask, side, settings) {
  const lineCount = mask.length;
  const fromEdge = side === "top" || side === "left";
  const subject = subjectBand(mask);

  // 整幅近乎全黑：没有可识别的主体，不做任何裁剪。
  if (!subject) return 0;

  const boundary = fromEdge ? subject[0] : lineCount - 1 - subject[1];
  const minBorder = Math.max(3, Math.round((lineCount * settings.minThickness) / 100));
  const maxBorder = Math.floor(lineCount * MAX_CROP_RATIO);
  if (boundary < minBorder || boundary > maxBorder) return 0;
  if (borderPurity(mask, boundary, fromEdge) <= MIN_BORDER_PURITY) return 0;
  return boundary;
}

function analyzeImage(image) {
  const profile = createProfile(image, state.settings);
  const rowMask = borderMask(profile.rows, state.settings);
  const columnMask = borderMask(profile.columns, state.settings);
  const maskBySide = { top: rowMask, bottom: rowMask, left: columnMask, right: columnMask };
  const detected = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const side of Object.keys(detected)) {
    if (!state.settings.sides[side]) continue;
    const depth = detectSide(maskBySide[side], side, state.settings);
    detected[side] = side === "top" || side === "bottom"
      ? Math.round(depth / profile.height * image.naturalHeight)
      : Math.round(depth / profile.width * image.naturalWidth);
  }
  return { detected, profile };
}

function cropImage(item, values) {
  const imageWidth = item.image.naturalWidth;
  const imageHeight = item.image.naturalHeight;
  const left = clamp(Math.round(values.left), 0, imageWidth - 1);
  const top = clamp(Math.round(values.top), 0, imageHeight - 1);
  const rightCrop = clamp(Math.round(values.right), 0, imageWidth - left - 1);
  const bottomCrop = clamp(Math.round(values.bottom), 0, imageHeight - top - 1);
  const width = imageWidth - left - rightCrop;
  const height = imageHeight - top - bottomCrop;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(item.image, left, top, width, height, 0, 0, width, height);
  return { canvas, values: { top, bottom: bottomCrop, left, right: rightCrop } };
}

function outputType(item) {
  return item.file.type === "image/png" ? "image/png" : "image/jpeg";
}

function outputName(item, index = null) {
  const original = item.file.name.replace(/\.[^.]+$/, "");
  const extension = outputType(item) === "image/png" ? "png" : "jpg";
  // Prefix batch files with their stable position. iOS may not preserve the
  // order in which multiple shared files appear in Photos, but the numbered
  // names keep the intended order attached to every exported image.
  const prefix = index === null ? "" : `${String(index + 1).padStart(3, "0")}-`;
  return `${prefix}${original}-trimmed.${extension}`;
}

function detectedLabel(values) {
  if (!values) return "检测失败";
  const parts = [];
  for (const [key, label] of [["top", "上"], ["bottom", "下"], ["left", "左"], ["right", "右"]]) {
    if (values[key] > 0) parts.push(`${label} ${values[key]}px`);
  }
  return parts.length ? `已检测：${parts.join(" · ")}` : "未发现满足条件的黑色直线边框";
}

function applyPadding(detected) {
  const padding = state.settings.padding;
  return Object.fromEntries(Object.entries(detected).map(([side, value]) => [
    side,
    value > 0 ? Math.max(0, value - padding) : 0,
  ]));
}

function renderEmpty() {
  results.innerHTML = '<div class="empty">选择图片后，检测结果会显示在这里。</div>';
  batchActions.hidden = true;
}

function renderCard(item) {
  const old = document.querySelector(`[data-item-id="${item.id}"]`);
  if (old) old.remove();
  const card = document.createElement("article");
  card.className = "result-card";
  card.dataset.itemId = item.id;
  const detected = item.detected;
  if (item.image && !item.error) {
    // 先把手动微调后的数值过一遍裁剪钳制，再拿它渲染，界面显示的才是真正生效的量。
    item.rendered = cropImage(item, item.values);
    item.values = item.rendered.values;
  }
  const values = item.values;
  const dimensionText = item.rendered
    ? `原图 ${item.image.naturalWidth} × ${item.image.naturalHeight}px · 输出 ${item.rendered.canvas.width} × ${item.rendered.canvas.height}px`
    : "无法读取图片";
  card.innerHTML = `
    <div class="result-head">
      <div>
        <h3>${escapeHtml(item.file.name)}</h3>
        <p>${dimensionText}</p>
      </div>
      <p class="detected">${escapeHtml(detectedLabel(detected))}</p>
    </div>
    ${item.error ? `<p class="error">${escapeHtml(item.error)}</p>` : `
      <p class="actual-crop">实际裁剪：上 ${values.top}px · 下 ${values.bottom}px · 左 ${values.left}px · 右 ${values.right}px</p>
      <div class="preview-grid">
        <div class="preview-block"><span>原图</span><canvas class="preview-canvas" width="1" height="1"></canvas></div>
        <div class="preview-block"><span>裁剪结果</span><img class="result-image" alt="裁剪结果" /></div>
      </div>
      <details class="fine-tune">
        <summary>手动微调四边（像素）</summary>
        <div class="crop-inputs">
          ${["top", "bottom", "left", "right"].map((side) => `<label>${{ top: "上", bottom: "下", left: "左", right: "右" }[side]}<input data-side-input="${side}" type="number" min="0" step="1" value="${values[side]}" /></label>`).join("")}
        </div>
      </details>
      <div class="card-actions">
        <button class="secondary-button" data-action="re-crop" type="button">重新裁剪</button>
        <button class="secondary-button" data-action="download" type="button">下载图片</button>
        <button class="primary-button" data-action="share" type="button">分享 / 存入照片</button>
      </div>
    `}`;
  results.appendChild(card);

  if (item.error) return;
  const originalCanvas = card.querySelector(".preview-canvas");
  originalCanvas.width = item.image.naturalWidth;
  originalCanvas.height = item.image.naturalHeight;
  originalCanvas.getContext("2d").drawImage(item.image, 0, 0);

  const resultImage = card.querySelector(".result-image");
  resultImage.src = item.rendered.canvas.toDataURL(outputType(item));

  card.querySelectorAll("[data-side-input]").forEach((input) => {
    input.addEventListener("change", () => {
      item.values[input.dataset.sideInput] = clamp(Number(input.value) || 0, 0, 100000);
      renderCard(item);
    });
  });
  card.querySelector('[data-action="re-crop"]').addEventListener("click", () => {
    renderCard(item);
  });
  card.querySelector('[data-action="download"]').addEventListener("click", () => downloadItem(item));
  card.querySelector('[data-action="share"]').addEventListener("click", () => shareItem(item));
}

function renderAll() {
  if (!state.items.length) return renderEmpty();
  results.innerHTML = "";
  state.items.forEach(renderCard);
  const validItems = state.items.filter((item) => item.image && !item.error);
  const failedCount = state.items.length - validItems.length;
  $("batchSummary").textContent = `已处理 ${validItems.length} 张${failedCount ? `，失败 ${failedCount} 张` : ""}`;
  batchActions.hidden = validItems.length === 0;
}

function createItem(file, index) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ id: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`, file, image });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} 无法读取`));
    };
    image.src = url;
  });
}

async function loadFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  $("status").textContent = `正在读取 ${files.length} 张图片…`;
  const loaded = [];
  for (let index = 0; index < files.length; index += 1) {
    try {
      loaded.push(await createItem(files[index], index));
    } catch (error) {
      loaded.push({ id: `${Date.now()}-${index}`, file: files[index], error: error.message });
    }
  }
  // 先把当前滑块值读进来，否则新导入的图会用上一次的旧参数分析。
  readSettings();
  state.items = loaded.map((item) => {
    if (item.error) return item;
    const analysis = analyzeImage(item.image);
    item.detected = analysis.detected;
    item.values = applyPadding(analysis.detected);
    return item;
  });
  $("status").textContent = `已读取 ${state.items.length} 张图片；每一条边独立判断。`;
  renderAll();
}

function reanalyzeAll() {
  readSettings();
  state.items.forEach((item) => {
    if (!item.image) return;
    const analysis = analyzeImage(item.image);
    item.detected = analysis.detected;
    item.values = applyPadding(analysis.detected);
  });
  renderAll();
  if (state.items.length) {
    $("status").textContent = `已应用当前参数：边界微调 ${state.settings.padding} px；请查看实际裁剪量和输出尺寸。`;
  }
}

function getOutputBlob(item) {
  // 保存前把还没提交的滑块输入应用掉，避免导出的图与界面显示不一致。
  applyChangedSettings();
  item.rendered = cropImage(item, item.values);
  return new Promise((resolve) => {
    item.rendered.canvas.toBlob(resolve, outputType(item), outputType(item) === "image/jpeg" ? 0.96 : undefined);
  });
}

async function downloadItem(item) {
  const blob = await getOutputBlob(item);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = outputName(item);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareItem(item) {
  const blob = await getOutputBlob(item);
  const file = new File([blob], outputName(item), { type: outputType(item) });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title: "四边扫描去黑边", files: [file] });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  await downloadItem(item);
}

function validItems() {
  return state.items.filter((item) => item.image && !item.error);
}

async function downloadAllItems(items = validItems()) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const blob = await getOutputBlob(item);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = outputName(item, index);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
}

async function shareAllItems() {
  const items = validItems();
  if (!items.length) return;
  const button = $("shareAll");
  button.disabled = true;
  button.textContent = "正在准备…";
  $("status").textContent = `正在生成 ${items.length} 张处理结果…`;
  try {
    const files = [];
    const shareStartTime = Date.now();
    for (let index = 0; index < items.length; index += 1) {
      const blob = await getOutputBlob(items[index]);
      files.push(new File([blob], outputName(items[index], index), {
        type: outputType(items[index]),
        // Keep a monotonically increasing timestamp as an additional order
        // hint for importers that inspect file metadata.
        lastModified: shareStartTime + index * 1000,
      }));
    }
    let canShareFiles = false;
    try {
      canShareFiles = Boolean(navigator.share && navigator.canShare && navigator.canShare({ files }));
    } catch (error) {
      canShareFiles = false;
    }
    if (canShareFiles) {
      try {
        await navigator.share({ title: `四边扫描去黑边（${files.length}张）`, files });
        $("status").textContent = "已打开系统分享面板；请选择“存储图像”保存到相册。";
      } catch (error) {
        if (error.name === "AbortError") return;
        await downloadAllItems(items);
        $("status").textContent = "系统无法一次分享这些图片，已改为逐张发起下载。";
      }
    } else {
      await downloadAllItems(items);
      $("status").textContent = "当前浏览器不支持多文件分享，已逐张发起下载。";
    }
  } catch (error) {
    if (error.name !== "AbortError") $("status").textContent = `批量保存失败：${error.message || "请重试"}`;
  } finally {
    button.disabled = false;
    button.textContent = "保存全部";
  }
}

Object.values(controls).forEach((control) => {
  control.addEventListener("input", settingsInput);
  control.addEventListener("change", applyChangedSettings);
});
document.querySelectorAll(".side-toggle").forEach((control) => control.addEventListener("change", applyChangedSettings));
$("fileInput").addEventListener("change", (event) => loadFiles(event.target.files));
$("reanalyze").addEventListener("click", reanalyzeAll);
$("resetSettings").addEventListener("click", resetSettings);
$("shareAll").addEventListener("click", shareAllItems);
$("downloadAll").addEventListener("click", () => downloadAllItems());

updateControlLabels();
renderEmpty();
if ("serviceWorker" in navigator && window.isSecureContext) {
  // 新版本 Service Worker 接管后自动刷新，避免继续停留在旧缓存里的界面。两条保护：
  //   1. 首次安装（此前没有 SW 接管）不刷新——那时页面本来就是刚从网络取的新版，
  //      刷新只会白白多加载一次。
  //   2. 手上已经导入图片时不刷新，避免把用户正在处理的这一批丢掉；新版本已经接管，
  //      下次打开页面自然就是新版，这里只提示一句。
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloadedForUpdate) return;
    reloadedForUpdate = true;
    if (state.items.length) {
      $("status").textContent = "已更新到新版本；为避免打断当前处理，刷新将在下次打开页面时生效。";
      return;
    }
    window.location.reload();
  });
  navigator.serviceWorker.register("sw.js").then((registration) => {
    // 打开时主动查一次更新；从后台切回来时再查一次，省得一直跑旧版本。
    // update() 不阻塞渲染，断网时静默失败，不影响离线启动。
    registration.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) registration.update().catch(() => {});
    });
  }).catch(() => {});
}
