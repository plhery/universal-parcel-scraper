import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's four-character verify code, letters and digits, read by the shared text model. */
export class MorelinkOcr extends OcrWorker {
  constructor() {
    super('MoreLink', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'morelink56' });
  }
}
