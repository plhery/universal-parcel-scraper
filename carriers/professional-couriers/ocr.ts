import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's five letters and digits, read by the shared text model once a picture needs reading. */
export class ProfessionalCouriersOcr extends OcrWorker {
  constructor() {
    super('The Professional Couriers', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'professional-couriers' });
  }

  override async solve(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    return (await super.solve(bytes, signal)).toUpperCase();
  }
}
