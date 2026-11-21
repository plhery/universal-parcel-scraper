import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { containerEvents, MAX_CONTAINER_LOOKUPS, ONE_ORIGIN, ONE_REPLY_MAX_BYTES, ONE_SEARCH, ONE_VALIDATE, oneEventsUrl, oneQuery, oneResult,
  oneSearch, PAGE_LENGTH, PROVIDER, validatedBooking, type OneEvents } from './parser.js';

export { containerEvents, oneQuery, oneResult, oneSearch, validatedBooking } from './parser.js';

/** Containers whose events are asked for at once. */
const CONCURRENCY = 4;

export class OceanNetworkExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = oneQuery(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      // The headers the page's script sends. The API answers without them too, but the site's edge challenges clients it does not take for browsers.
      const headers = () => ({ Accept: 'application/json, text/plain, */*', Origin: ONE_ORIGIN, Referer: `${ONE_ORIGIN}/`,
        'Cache-Control': 'no-cache, no-store, must-revalidate', 'x-correlation-id': globalThis.crypto.randomUUID(), 'User-Agent': userAgent });
      const ask = async (url: string, body?: unknown) => {
        const init: RequestInit = body === undefined ? { headers: headers() }
          : { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, fetcher: this.options.fetcher,
          timeoutMs: remaining(), maxBytes: ONE_REPLY_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [403, 404, 410] });
        signal.throwIfAborted();
        // Cloudflare in front of the site refuses a client it takes for a bot.
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'ONE refused public tracking');
        // The API answers its posts with 201. A moved or missing endpoint is a changed tracker, not a missing shipment.
        if (response.status !== 200 && response.status !== 201) throw new TransportError(PROVIDER, 'ONE tracking is unavailable', { status: response.status });
        return decodeText(bytes);
      };

      const timestamp = String(Date.now());
      const booking = query.kind === 'booking'
        ? validatedBooking(await ask(ONE_VALIDATE, { bookingNos: query.booking, timestamp }), query.booking) : undefined;
      const search = oneSearch(await ask(ONE_SEARCH, { page: 1, page_length: PAGE_LENGTH,
        filters: { search_text: booking ?? query.number, search_type: booking ? 'BKG_NO' : 'CNTR_NO' }, timestamp }), query, booking);
      const containers = search.containers.filter(item => item.container).slice(0, MAX_CONTAINER_LOOKUPS);
      const read: OneEvents[] = [];
      for (let start = 0; start < containers.length; start += CONCURRENCY) {
        read.push(...await Promise.all(containers.slice(start, start + CONCURRENCY)
          .map(async item => containerEvents(await ask(oneEventsUrl(item.booking, item.container))))));
      }
      return oneResult(search, read);
    };
    // A failed container read ends the others still running, so none outlives its attempt.
    const ending = (signal: AbortSignal, timeoutMs: number) => {
      const sibling = new AbortController();
      return read(AbortSignal.any([signal, sibling.signal]), timeoutMs).finally(() => sibling.abort());
    };
    return runSteps({ carrier: 'ocean-network-express', budgetMs: context.budgetMs ?? 25_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => ending(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => ending(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OceanNetworkExpressTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'ocean-network-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
