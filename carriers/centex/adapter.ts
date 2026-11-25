import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { InvalidInputError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, CENTEX_MAX_BYTES, CENTEX_WAYBILL, normalizeCentexNumber, parseCentexPage, PROVIDER } from './parser.js';

/**
 * The tracker's list page, which the site's tracking form posts to. Asked by GET it needs no image code, session or
 * account; the form on `get-track-detail` asks for an image code only for its POST.
 */
export const CENTEX_TRACK_URL = 'https://www.baxida.cn/default/index/track';

export const centexLookupUrl = (number: string): string => `${CENTEX_TRACK_URL}?trackNos=${encodeURIComponent(number)}`;

export class CentexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCentexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(centexLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: CENTEX_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), allowHttpStatuses: [404, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'CENTEX tracking page is unavailable', { status: response.status });
      return parseCentexPage(decodeText(bytes), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CentexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Only CENTEX's own waybills: the Correios number belongs to Correios.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => {
        if (!CENTEX_WAYBILL.test(normalizeCentexNumber(number))) throw new InvalidInputError(PROVIDER, 'Not a CENTEX waybill');
      })),
  };
};
