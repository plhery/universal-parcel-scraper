import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's four-digit verify code, read by the shared text model. */
export class ChinaqingguanOcr extends OcrWorker {
  constructor() {
    super('Rongtong International', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'chinaqingguan' });
  }
}
