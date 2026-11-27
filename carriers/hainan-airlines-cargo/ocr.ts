import { OcrWorker } from '../../core/transport/ocrWorker.js';

/** The tracker's four letters, read by the shared text model; the tracker takes them in any case. */
export class HainanCargoOcr extends OcrWorker {
  constructor() {
    super('Hainan Airlines Cargo', new URL('../../core/transport/text-captcha-worker.mjs', import.meta.url), { profile: 'hainan-airlines-cargo' });
  }

  override async solve(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    return (await super.solve(bytes, signal)).toUpperCase();
  }
}
