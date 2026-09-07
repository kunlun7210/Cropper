
const DEFAULTS = {
  darkThreshold: 42,
  coverage: 92,
  minThickness: 1,
  padding: 0,
  sides: { top: true, bottom: true, left: true, right: true },
};

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

function findInteriorBoundary(profile, side, settings) {
  const lineCount = profile.length;
  const fromEdge = side === "top" || side === "left";
  const direction = fromEdge ? -1 : 1;
  const center = Math.floor(lineCount / 2);
  const minimumRun = Math.max(6, Math.round(lineCount * Math.max(settings.minThickness / 100, 0.01)));
  const maximumCrop = Math.floor(lineCount * 0.45);
  const maximumDistance = Math.floor(lineCount * 0.5);

  // Start at the likely subject area and walk toward the selected side. A
  // real screenshot bar usually has a sharp transition from content to a
  // long, uniform near-black run. Requiring a run avoids mistaking a single
  // dark line or a dark object in the subject for a border.
  let runLength = 0;
  let runFirstIndex = null;
  for (let offset = 0; offset <= maximumDistance; offset += 1) {
    const index = center + offset * direction;
    if (index < 0 || index >= lineCount) break;

    if (qualifies(profile[index], settings)) {
      if (runLength === 0) runFirstIndex = index;
      runLength += 1;
      if (runLength < minimumRun) continue;

      // runFirstIndex is the inner edge of the run because the scan starts
      // from the content and travels outward. Convert it to the amount to
      // remove from the actual outside edge.
      const boundary = fromEdge ? runFirstIndex + 1 : runFirstIndex;
      const cropDepth = fromEdge ? boundary : lineCount - boundary;
      if (cropDepth > maximumCrop) return 0;

      // A dark stripe inside the subject is not a border. Only accept a
      // center-out candidate when its entire outside region is near-black.
      const outside = fromEdge ? profile.slice(0, boundary) : profile.slice(boundary);
      if (!outside.every((line) => qualifies(line, settings))) return 0;

      const contentIndex = fromEdge ? boundary : boundary - 1;
      if (contentIndex < 0 || contentIndex >= lineCount) return 0;
      const borderMean = profile
        .slice(fromEdge ? runFirstIndex - runLength + 1 : runFirstIndex,
          fromEdge ? runFirstIndex + 1 : runFirstIndex + runLength)
        .reduce((sum, line) => sum + line.meanMaxChannel, 0) / runLength;
      const contentContrast = profile[contentIndex].meanMaxChannel - borderMean;
      if (contentContrast < Math.max(12, settings.darkThreshold * 0.3)) return 0;
      return cropDepth;
    }

    // A short dark patch inside a photo is not enough. Reset and keep
    // scanning so a later, longer screenshot bar can still be found.
    runLength = 0;
    runFirstIndex = null;
  }

  return 0;
}

function detectSide(profile, side, settings) {
  const lineCount = profile.length;
  const minDepth = Math.max(3, Math.round(lineCount * settings.minThickness / 100));
  const maxDepth = Math.floor(lineCount * 0.45);
  const gapAllowance = Math.max(1, Math.round(lineCount * 0.002));
  const fromEdge = side === "top" || side === "left";
  if (!qualifies(profile[fromEdge ? 0 : lineCount - 1], settings)) return 0;

  // First preserve the original edge-connected detection for clean bars.
  let edgeDepth = 0;
  let edgeBadStreak = 0;
  for (let offset = 0; offset < maxDepth; offset += 1) {
    const index = fromEdge ? offset : lineCount - 1 - offset;
    if (qualifies(profile[index], settings)) {
      edgeDepth = offset + 1;
      edgeBadStreak = 0;
    } else {
      edgeBadStreak += 1;
      if (edgeBadStreak > gapAllowance) break;
    }
  }

  const interiorDepth = findInteriorBoundary(profile, side, settings);
  if (edgeDepth < minDepth) return interiorDepth;

  const insideStart = fromEdge ? edgeDepth : lineCount - edgeDepth - 1;
  const boundaryWindow = Math.max(3, Math.round(lineCount * 0.006));
  let contentLines = 0;
  for (let i = 1; i <= boundaryWindow; i += 1) {
    const index = fromEdge ? insideStart + i : insideStart - i;
    if (index >= 0 && index < lineCount && !qualifies(profile[index], settings)) contentLines += 1;
  }

  // If the whole image is near-black, there is no identifiable border.
  if (contentLines < Math.ceil(boundaryWindow * 0.55)) return interiorDepth;

  const averageEdgeDarkness = profile.slice(
    fromEdge ? 0 : lineCount - edgeDepth,
    fromEdge ? edgeDepth : lineCount,
  ).reduce((sum, line) => sum + line.meanMaxChannel, 0) / edgeDepth;

  if (averageEdgeDarkness > settings.darkThreshold * 1.12) edgeDepth = 0;

  // Both candidates must be connected to the outside edge. Content outside
  // an internal stripe is preserved, even if that means manual adjustment.
  return Math.max(edgeDepth, interiorDepth);
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
    item.rendered = cropImage(item, item.values);
    item.values = item.rendered.values;
  }
  const values = item.values;
  const dimensionText = item.rendered ? `原图 ${item.image.naturalWidth} × ${item.image.naturalHeight}px · 输出 ${item.rendered.canvas.width} × ${item.rendered.canvas.height}px` : "无法读取图片";
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
  if (state.items.length) $("status").textContent = `已应用当前参数：边界微调 ${state.settings.padding} px；请查看实际裁剪量和输出尺寸。`;
}

function getOutputBlob(item) {
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
