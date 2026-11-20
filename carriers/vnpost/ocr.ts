import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's four-character pictures, read by VNPost's own model. */
export class VnpostOcr extends OcrWorker {
  constructor() {
    super('VNPost', new URL('./ocr-worker.mjs', import.meta.url));
  }
}
