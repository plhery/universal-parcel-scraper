import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isTpChallenge, normalizeTpNumber, parseTpHistory, parseTpSearch, PROVIDER, TP_MAX_BYTES, tpHistoryUrl, tpSearchUrl,
} from './parser.js';

export { TP_HISTORY, TP_SEARCH, tpHistoryUrl, tpSearchUrl } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class TpLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTpNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'tp-logistics-th', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /**
   * The search page for the number, then the history page its button opens.
   * Neither needs a cookie, a form post or a browser. A number the search
   * page does not hold is not asked again on the history page.
   */
  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const page = async (url: string, what: string): Promise<string> => {
      const { response, bytes } = await fetchBounded(url, {
        method: 'GET', signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8', 'User-Agent': userAgent },
      }, { provider: PROVIDER, timeoutMs: left(), maxBytes: TP_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      const body = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, isTpChallenge(body) ? `TP Logistics answered its ${what} with a browser check`
          : `TP Logistics refused its ${what}`, { status: 403 });
      }
      // A moved or missing page is no answer about the parcel.
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, `TP Logistics moved its ${what}`);
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, `TP Logistics' ${what} is unavailable`);
      return body;
    };
    const listings = parseTpSearch(await page(tpSearchUrl(number), 'search page'), number);
    signal.throwIfAborted();
    return parseTpHistory(await page(tpHistoryUrl(number), 'history page'), number, listings);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TpLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tp-logistics-th', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTpNumber(number))),
  };
};
