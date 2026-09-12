
const DEFAULTS = {
  darkThreshold: 42,
  coverage: 92,
  minThickness: 1,
  padding: 0,
  sides: { top: true, bottom: true, left: true, right: true },
};

// 待裁条带中"近黑行"的占比下限（严格大于才算边框）。用"多数"而不是某个
// 手感阈值：条带里黑的部分多于不黑的部分，才说明这条确实是边框，或被界面
// 工具条包住的边框；相等或偏少时按不裁处理（保守），避免为了夹在画面中间
// 的暗色物体牺牲外侧真实内容。
const MIN_BORDER_PURITY = 0.5;
// 单边最多裁掉轴长的比例，作为"主体至少还要占 1/4"的兜底保护。
const MAX_CROP_RATIO = 0.75;

const state = { items: [], settings: structuredClone(DEFAULTS) };
const $ = (id) => document.getElementById(id);
const results = $("results");
const batchActions = $("batchActions");

const controls = {
  darkThreshold: $("darkThreshold"),
  coverage: $("coverage"),
  minThickness: $("minThickness"),
  padding: $("padding"),
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
  document.querySelectorAll(".side-toggle").forEach((input) => {
    input.checked = DEFAULTS.sides[input.dataset.side];
  });
  updateControlLabels();
  readSettings();
  reanalyzeAll();
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
    let darkCount = 0;
    let count = 0;
    let total = 0;
    let maxTotal = 0;
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const maxChannel = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (maxChannel <= settings.darkThreshold) darkCount += 1;
      maxTotal += maxChannel;
      total += luma(pixels[index], pixels[index + 1], pixels[index + 2]);
      count += 1;
    }
    rows.push({ darkRatio: darkCount / count, meanMaxChannel: maxTotal / count, meanLuma: total / count });
  }

  for (let x = 0; x < width; x += 1) {
    let darkCount = 0;
    let count = 0;
    let total = 0;
    let maxTotal = 0;
    for (let y = 0; y < height; y += stride) {
      const index = (y * width + x) * 4;
      const maxChannel = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (maxChannel <= settings.darkThreshold) darkCount += 1;
      maxTotal += maxChannel;
      total += luma(pixels[index], pixels[index + 1], pixels[index + 2]);
      count += 1;
    }
    columns.push({ darkRatio: darkCount / count, meanMaxChannel: maxTotal / count, meanLuma: total / count });
  }

  return { width, height, rows, columns };
}

function qualifies(profileLine, settings) {
  // darkRatio prevents a single black patch from being treated as a full-width bar.
  // meanMaxChannel keeps a noisy dark-gray line from passing only on pixel count.
  const darkEnough = profileLine.darkRatio >= settings.coverage / 100;
  const luminanceEnough = profileLine.meanMaxChannel <= settings.darkThreshold * 1.18;
  return darkEnough && luminanceEnough;
}

// 把逐行/逐列剖面切成「近黑段」与「内容段」，返回所有内容段的 [起, 止] 索引。
// 内容段 = 连续不满足 qualifies 的行（列），与"黑段夹在哪"无关。
function contentBands(profile, settings) {
  const bands = [];
  let start = null;
  for (let index = 0; index < profile.length; index += 1) {
    if (qualifies(profile[index], settings)) {
      if (start !== null) {
        bands.push([start, index - 1]);
        start = null;
      }
    } else if (start === null) {
      start = index;
    }
  }
  if (start !== null) bands.push([start, profile.length - 1]);
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
function subjectBand(profile, settings) {
  const bands = contentBands(profile, settings);
  if (!bands.length) return null;
  const center = Math.floor(profile.length / 2);
  const containing = bands.find((band) => center >= band[0] && center <= band[1]);
  if (containing) return containing;
  return bands.reduce((best, band) => (band[1] - band[0] > best[1] - best[0] ? band : best));
}

// 待裁条带里近黑行占多大比例。占比过半说明这一条确实是边框（或它外侧的
// 界面工具条）；占比不过半说明黑条夹在画面中间，不该为了它切掉外侧内容。
function borderPurity(profile, settings, boundary, fromEdge) {
  const strip = fromEdge
    ? profile.slice(0, boundary)
    : profile.slice(profile.length - boundary);
  if (!strip.length) return 0;
  return strip.filter((line) => qualifies(line, settings)).length / strip.length;
}

function detectSide(profile, side, settings) {
  const lineCount = profile.length;
  const fromEdge = side === "top" || side === "left";
  const subject = subjectBand(profile, settings);

  // 整幅近乎全黑：没有可识别的主体，不做任何裁剪。
  if (!subject) return 0;

  const boundary = fromEdge ? subject[0] : lineCount - 1 - subject[1];
  const minBorder = Math.max(3, Math.round((lineCount * settings.minThickness) / 100));
  const maxBorder = Math.floor(lineCount * MAX_CROP_RATIO);
  if (boundary < minBorder || boundary > maxBorder) return 0;
  if (borderPurity(profile, settings, boundary, fromEdge) <= MIN_BORDER_PURITY) return 0;
  return boundary;
}

function analyzeImage(image) {
  const profile = createProfile(image, state.settings);
  const detected = { top: 0, bottom: 0, left: 0, right: 0 };
  const profileBySide = { top: profile.rows, bottom: profile.rows, left: profile.columns, right: profile.columns };
  for (const side of Object.keys(detected)) {
    if (!state.settings.sides[side]) continue;
    const depth = detectSide(profileBySide[side], side, state.settings);
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
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
