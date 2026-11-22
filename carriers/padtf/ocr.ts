import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's four letters and digits, read by the shared text model once a picture needs reading. */
export class PadtfOcr extends OcrWorker {
  constructor() {
    super('PAD Express', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'padtf' });
  }

  override async solve(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    return (await super.solve(bytes, signal)).toUpperCase();
  }
}
