import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AMASS_MAX_BYTES, amassQuery, parseAmass, PROVIDER } from './parser.js';

/** The order tracking page, whose search the adapter makes. */
export const AMASS_PAGE = 'https://www.amassfreight.com/trace/';
/** The page's search, which answers an order's steps. */
export const AMASS_TRACKER = 'https://www.amassfreight.com/trace/info';
// A bot check a CDN could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Access Denied|<title>\s*Attention Required/i;

export class AmassTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const query = amassQuery(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      signal.throwIfAborted();
      // The page sends the number with an empty channel.
      const body = new URLSearchParams({ sn: query.number, channel: '' }).toString();
      const { response, bytes } = await fetchBounded(AMASS_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent), 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://www.amassfreight.com', Referer: AMASS_PAGE,
      }, body }, { provider: PROVIDER, timeoutMs, maxBytes: AMASS_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [403, 404, 429], fetcher: this.options.fetcher });
      const text = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AMASS refused the search', { status: response.status });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'AMASS\'s search is unavailable', { status: response.status });
      return parseAmass(text, query);
    };
    // A search that fails to reach the tracker gets one more. The tracker takes about twenty
    // seconds to answer for a number it does not hold, so the first search gets the whole budget.
    return runSteps({ carrier: 'amass', budgetMs: context.budgetMs ?? 35_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, remainingMs) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AmassTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'amass', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
