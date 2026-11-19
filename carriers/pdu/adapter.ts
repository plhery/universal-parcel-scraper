import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePduNumber, parsePdu, PDU_ENDPOINT, PDU_MAX_BYTES, PDU_PAGE, pduJson, PROVIDER } from './parser.js';

export class PduTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePduNumber(raw);
    return runSteps({ carrier: 'pdu', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(PDU_ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://www.pduni.com', Referer: PDU_PAGE,
          'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify([number]) }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: PDU_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [404, 410], fetcher: this.options.fetcher,
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (response.status !== 200) throw new TransportError(PROVIDER, 'PDU tracking service is unavailable', { status: response.status });
      return parsePdu(pduJson(decodeText(bytes)), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PduTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'pdu', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    // The waybill inquiry answers an unknown number with an empty list, so one request settles it.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePduNumber(number))) };
};
