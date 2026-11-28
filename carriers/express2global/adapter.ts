import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, E2G_MAX_BYTES, normalizeE2gNumber, parseE2g, PROVIDER } from './parser.js';

export { e2gText, normalizeE2gNumber, parseE2g } from './parser.js';

/** The tracking page, whose script posts here, over plain HTTP: the site's HTTPS certificate is another host's. */
export const E2G_TRACKING = 'http://www.hainaexpress.com/track/tracking';
const E2G_PAGE = 'http://www.hainaexpress.com/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The form the tracking page's script posts: one number. */
export function e2gForm(number: string): URLSearchParams {
  return new URLSearchParams({ num: number });
}

export class E2gTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session, token or account.
    const { response, bytes } = await fetchBounded(E2G_TRACKING, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: E2G_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: e2gForm(number).toString() }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: E2G_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved page.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking service is unavailable`, { status: response.status });
    return parseE2g(decodeText(bytes).replace(/^\uFEFF/, ''), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeE2gNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new E2gTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeE2gNumber(number))),
  };
};
