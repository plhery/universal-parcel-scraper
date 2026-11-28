import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeSutongstNumber, notJson, parseSutongst, PROVIDER, SUTONGST_MAX_BYTES } from './parser.js';

export { normalizeSutongstNumber, parseSutongst, placeClock, sutongstText } from './parser.js';

/** The route the tracking page on sutongst.com asks. */
export const SUTONGST_API = 'https://www.sutongst.com/API/Express/';
/** The tracking page, whose hidden inputs give the route's fixed `id` and `com`. */
export const SUTONGST_PAGE = 'https://www.sutongst.com/list-1793.html';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The page's request: its two fixed inputs and the waybill. */
export function sutongstLookupUrl(number: string): string {
  return `${SUTONGST_API}?${new URLSearchParams({ id: 'SUTONG', com: '88889', nu: number })}`;
}

export class SutongstTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no cookie, token or account.
    const { response, bytes } = await fetchBounded(sutongstLookupUrl(number), { signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
      Referer: SUTONGST_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: SUTONGST_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 404, 405, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route or a request the site now refuses.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    const body = decodeText(bytes).replace(/^\s+/u, '');
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      notJson(body);
    }
    return parseSutongst(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSutongstNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SutongstTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSutongstNumber(number))),
  };
};
