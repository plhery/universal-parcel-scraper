import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's BotDetect pictures, read by the shared text model as capital letters and digits. */
export class JetizzOcr extends OcrWorker {
  constructor() {
    super('Jetizz', new URL('./ocr-worker.mjs', import.meta.url));
  }
}
