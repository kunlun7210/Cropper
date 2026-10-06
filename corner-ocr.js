/* 可选资源与基础启动缓存分离，模型/图片都在当前设备处理。 */
const CornerOCR = (() => {
  const CACHE = 'cropper-ocr-v1';
  async function create(onStatus = () => {}) {
    const base = new URL('./', document.baseURI);
    onStatus('正在准备四角识别；首次使用需下载模型与运行组件…');
    const response = await fetch(new URL('ocr/manifest-v1.json', base));
    if (!response.ok) throw new Error('无法读取增强组件清单，请联网重试');
    if (!('caches' in window) || !('serviceWorker' in navigator) || !window.isSecureContext) throw new Error('此浏览器不支持增强识别，请在 HTTPS 或本地环境使用');
    const manifest = await response.clone().json();
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('增强组件清单无效');
    const cache = await caches.open(CACHE);
    const urls = [];
    let done = 0;
    try {
      for (const entry of manifest.files) {
        if (!/^ocr\/(runtime-v1|models-v1)\/[\w./-]+$/.test(entry.file) || entry.file.includes('..')) throw new Error('增强组件路径无效');
        const url = new URL(entry.file, base).href;
        let asset = await cache.match(url, { ignoreVary: true });
        if (!asset) {
          asset = await fetch(url);
          if (!asset.ok) throw new Error('增强组件下载失败，请联网重试');
          const bytes = await asset.clone().arrayBuffer();
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
          if (bytes.byteLength !== entry.bytes || hash !== entry.sha256) throw new Error('增强组件校验失败，请刷新后重试');
          await cache.put(url, asset.clone());
        }
        if (entry.file.startsWith('ocr/models-v1/')) urls.push(URL.createObjectURL(await asset.blob()));
        onStatus(`正在准备四角识别组件 ${++done}/${manifest.files.length}…`);
      }
      await cache.put(new URL('ocr/manifest-v1.json', base).href, response);
      // worker 与动态模块的离线请求由已接管的 Service Worker 读取独立缓存。
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
      onStatus('正在初始化本地文字识别…');
      const logoResponse = await cache.match(new URL('ocr/runtime-v1/brand-logos.json', base).href, { ignoreVary: true });
      const { templates } = await logoResponse.json();
      const { createEngine } = await import('./ocr/runtime-v1/engine.js');
      const engine = await createEngine({ models: urls, ortBase: new URL('ocr/runtime-v1/ort/', base).href });
      return {
        async scan(image, photo, onCorner = () => {}) {
          const marks = [], observations = [];
          for (const roi of CornerDetector.corners(photo)) {
            onCorner(roi.corner);
            const canvas = document.createElement('canvas');
            canvas.width = roi.width; canvas.height = roi.height;
            const g = canvas.getContext('2d', { willReadFrequently: true });
            g.drawImage(image, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);
            const pixels = g.getImageData(0, 0, roi.width, roi.height).data;
            const predictions = await engine.predict(canvas);
            const items = predictions.flatMap(prediction => prediction.items || []);
            observations.push({ corner: roi.corner, width: roi.width, height: roi.height, texts: items.map(({ text, score, poly }) => ({ text, score, poly })) });
            for (const item of CornerDetector.combineItems(items)) {
              const mark = CornerDetector.accept(item, roi, photo, pixels, templates);
              if (mark) marks.push(mark);
            }
            canvas.width = canvas.height = 1;
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          return { marks, observations };
        },
        async dispose() { try { await engine.dispose(); } finally { urls.forEach(url => URL.revokeObjectURL(url)); } },
      };
    } catch (error) {
      urls.forEach(url => URL.revokeObjectURL(url));
      throw error;
    }
  }
  return { create };
})();
