import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, LERDEX_MAX_BYTES, lerdexJson, normalizeLerdexNumber, parseLerdex, PROVIDER } from './parser.js';

/** The lookup the public tracking page makes. */
export const LERDEX_API = 'https://api.bestdealer.com/logistics/orderTracking/queryOrderTracking';
export const LERDEX_PAGE = 'https://website.bestdealer.com/tracking.html';
// The key the public tracking page sends every visitor's lookup with.
export const LERDEX_KEY = '8605fa8f43a0689ea7d0b210c6df0cd4'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];

export class LerdexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeLerdexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(LERDEX_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', tk: LERDEX_KEY, Referer: LERDEX_PAGE,
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ numbers: [number] }) }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: LERDEX_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 405, 410] });
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Lerdex tracking lookup is unavailable', { status: response.status });
      return parseLerdex(lerdexJson(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LerdexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLerdexNumber(number))),
  };
};
