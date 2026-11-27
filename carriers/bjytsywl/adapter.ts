import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BJYTSYWL_MAX_BYTES, CARRIER, normalizeBjytsywlNumber, parseBjytsywl, PROVIDER } from './parser.js';

export { normalizeBjytsywlNumber, parseBjytsywl } from './parser.js';

/** The tracking page. The form on it posts here, over plain HTTP: the site's HTTPS certificate is another host's. */
export const BJYTSYWL_TRACKER = 'http://www.bjytsywl.com/wuliuinfo.html';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The form the tracking page posts: one number, and the `g` field the form carries. */
export function bjytsywlForm(number: string): URLSearchParams {
  return new URLSearchParams({ g: '1', cnum: number });
}

export class BjytsywlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session, token or account.
    const { response, bytes } = await fetchBounded(BJYTSYWL_TRACKER, { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Content-Type': 'application/x-www-form-urlencoded',
      Referer: BJYTSYWL_TRACKER, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: bjytsywlForm(number).toString() }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: BJYTSYWL_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved page.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking page is unavailable`, { status: response.status });
    return parseBjytsywl(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeBjytsywlNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BjytsywlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBjytsywlNumber(number))),
  };
};
