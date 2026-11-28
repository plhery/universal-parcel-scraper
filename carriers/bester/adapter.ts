import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BESTER_MAX_BYTES, CARRIER, isChallenge, normalizeBesterNumber, parseBester, PROVIDER } from './parser.js';

export { besterText, normalizeBesterNumber, parseBester } from './parser.js';

/** The request the waybill page sends on opening, for the fragment it shows. */
export const BESTER_LOOKUP = 'https://www.exbtr.com/index.php?m=content&c=index&a=orderAjax';
/** The waybill page, which takes the number from its address. */
export const BESTER_PAGE = 'https://www.exbtr.com/waybill.html';
// The member code the page sends with every lookup, the same for every visitor.
const PAGE_USER = 'T00195';
const REDIRECTS = [301, 302, 303, 307, 308];
// The server is in Taiwan and sometimes slow to answer from abroad.
const DEFAULT_BUDGET_MS = 20_000;

/**
 * The page's form for one number: the page sends `status=2` on opening, which skips the verification code it no
 * longer asks for, and an empty `code`.
 */
export function besterForm(number: string): string {
  return new URLSearchParams({ trackingNo: number, user: PAGE_USER, code: '', siteid: '1', status: '2' }).toString();
}

export class BesterTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session or account.
    const { response, bytes } = await fetchBounded(BESTER_LOOKUP, {
      method: 'POST', signal, body: besterForm(number), headers: {
        Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', Origin: 'https://www.exbtr.com',
        Referer: `${BESTER_PAGE}?${new URLSearchParams({ orderid: number })}`, 'User-Agent': userAgentOf(this.options.userAgent),
      },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: BESTER_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    }
    return parseBester(decodeText(bytes).replace(/^\uFEFF/, ''), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeBesterNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BesterTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBesterNumber(number))),
  };
};
