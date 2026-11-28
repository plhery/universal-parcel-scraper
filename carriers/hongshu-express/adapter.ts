import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, HONGSHU_MAX_BYTES, normalizeHongshuNumber, parseHongshu, PROVIDER } from './parser.js';

/** The page HongShu's tracking form posts to, over plain HTTP: the site serves no HTTPS. */
export const HONGSHU_LOOKUP = 'http://hexpress.ca/Track';
/** The site whose form posts there, sent as the Referer. */
export const HONGSHU_SITE = 'http://hexpress.ca/';
const REDIRECTS = [301, 302, 303, 307, 308];

export class HongshuTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeHongshuNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The form's one field, which takes a number per line; the number alone, with no session or account.
      const body = new URLSearchParams({ transactionid: number }).toString();
      const { response, bytes } = await fetchBounded(HONGSHU_LOOKUP, { method: 'POST', signal, body, headers: {
        Accept: 'text/html, */*', 'Content-Type': 'application/x-www-form-urlencoded', Referer: HONGSHU_SITE,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: HONGSHU_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // An unknown number is HTTP 200 too; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
      return parseHongshu(decodeText(bytes), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HongshuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHongshuNumber(number))),
  };
};
