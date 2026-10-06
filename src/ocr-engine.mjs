import { PaddleOCR } from '@paddleocr/paddleocr-js';

// 只在用户开启增强识别后动态导入；SDK 内部专用 worker 执行推理。
export async function createEngine({ models, ortBase }) {
  const ocr = await PaddleOCR.create({
    lang: 'ch', ocrVersion: 'PP-OCRv6', worker: true,
    textDetectionModelName: 'PP-OCRv6_small_det',
    textRecognitionModelName: 'PP-OCRv6_small_rec',
    textDetectionModelAsset: { url: models[0] },
    textRecognitionModelAsset: { url: models[1] },
    ortOptions: { backend: 'wasm', wasmPaths: ortBase, numThreads: 1, simd: true },
  });
  return { predict: canvas => ocr.predict(canvas), dispose: () => ocr.dispose() };
}
