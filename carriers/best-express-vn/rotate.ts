import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** BEST's round pictures, matched against the pictures it draws them from to find how far they are turned. */
export class BestRotate extends OcrWorker {
  constructor(provider: string) {
    super(provider, new URL('./rotate-worker.mjs', import.meta.url));
  }
}
