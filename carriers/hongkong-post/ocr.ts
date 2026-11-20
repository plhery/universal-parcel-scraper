import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's MTCaptcha pictures, read by the shared text model once a picture needs reading. */
export class HongkongPostOcr extends OcrWorker {
  constructor() {
    super('Hongkong Post', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'mtcaptcha' });
  }
}
