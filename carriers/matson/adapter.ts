import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { MATSON_LOOKUP, MATSON_ORIGIN, MATSON_PAGE, MATSON_PAGE_MAX_BYTES, MATSON_REPLY_MAX_BYTES, matsonQuery, matsonToken, parseMatsonReply, PROVIDER } from './parser.js';

export { parseMatsonReply } from './parser.js';

// Matson's replies carry a Content-Security-Policy header of about 25 KB, past the 16 KB Node's fetch reads.
const MAX_HEADER_BYTES = 64 * 1024;
let wideHeaders: typeof fetch | undefined;
const wideHeadersFetch = () => wideHeaders ??= fetchTrusting([], { maxHeaderSize: MAX_HEADER_BYTES });

export class MatsonTracker {
  readonly #fetcher: typeof fetch;

  /** Over the global fetch, the replies are read with room for their headers; a host's own fetcher is used as given. */
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {
    this.#fetcher = transportOf(options.fetcher) === undefined ? wideHeadersFetch() : options.fetcher!;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = matsonQuery(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const ask = async (url: string, init: RequestInit, maxBytes: number) => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, fetcher: this.#fetcher,
          timeoutMs: remaining(), maxBytes, redirect: 'manual', allowHttpStatuses: [403, 404, 410] });
        signal.throwIfAborted();
        // The site refuses a client it does not take for a browser, and a lookup without the page's token or script headers.
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'Matson refused public tracking');
        // A moved or missing page is a changed tracker, not a missing shipment.
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Matson tracking is unavailable', { status: response.status });
        return decodeText(bytes);
      };

      const token = matsonToken(await ask(MATSON_PAGE, { headers: { Accept: 'text/html', 'User-Agent': userAgent } }, MATSON_PAGE_MAX_BYTES));
      const reply = await ask(MATSON_LOOKUP, {
        method: 'POST',
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', Origin: MATSON_ORIGIN, Referer: MATSON_PAGE, 'User-Agent': userAgent },
        body: new URLSearchParams({ container_trackingnumber: query.number, trackingVal: query.trackingVal, ttr: token }).toString(),
      }, MATSON_REPLY_MAX_BYTES);
      return parseMatsonReply(reply, query);
    };
    return runSteps({ carrier: 'matson', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new MatsonTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'matson', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
