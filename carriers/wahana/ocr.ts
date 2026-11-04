import { OcrWorker } from '../../core/transport/ocrWorker.js';

export class WahanaOcr extends OcrWorker {
  constructor() { super('Wahana Express', new URL('./ocr-worker.mjs', import.meta.url)); }
}
