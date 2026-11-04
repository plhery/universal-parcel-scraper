import { OcrWorker } from '../../core/transport/ocrWorker.js';

export class ChunghwaPostOcr extends OcrWorker {
  constructor() {
    super('Chunghwa Post', new URL('./ocr-worker.mjs', import.meta.url));
  }
}
