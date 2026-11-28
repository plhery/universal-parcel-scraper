import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's four-digit verify code, read by the shared text model. */
export class SunspeedyOcr extends OcrWorker {
  constructor() {
    super('Sunspeedy', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'sunspeedy' });
  }
}
