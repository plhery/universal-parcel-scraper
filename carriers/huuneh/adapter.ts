import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HUUNEH_MAX_BYTES, huunehUrl, normalizeHuunehNumber, parseHuuneh, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown waybill with HTTP 200, so a missing route is not a missing waybill.
const GONE = [404, 410];

export class HuunehTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHuunehNumber(raw), url = huunehUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HUUNEH_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 401, 403] });
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) throw new ChallengeError(PROVIDER, 'Huuneh refused public tracking', { status: response.status });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Huuneh redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Huuneh tracking page is unavailable', { status: response.status });
      if (response.url && response.url !== url) throw new SchemaError(PROVIDER, 'Huuneh returned another tracking route');
      const html = decodeText(bytes).replace(/^\uFEFF/, '');
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Huuneh returned an empty page');
      return parseHuuneh(html, number);
    };
    // A request that fails to reach Huuneh, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'huuneh', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new HuunehTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'huuneh', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHuunehNumber(number))),
  };
};
