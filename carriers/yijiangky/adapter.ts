import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeYijiangNumber, parseYijiang, PROVIDER, YIJIANG_MAX_BYTES } from './parser.js';

/** The tracking page, over plain HTTP: the site does not answer HTTPS. Its script posts the lookup to the page itself. */
export const YIJIANG_TRACKER = 'http://www.yijiangky.com/query.aspx?pID=3';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address: the page with the random `v` its script adds to keep caches out. */
export const yijiangLookupUrl = (random = Math.random()): string => `${YIJIANG_TRACKER}&v=${random}`;

/**
 * The form the page's script posts for one waybill. `key` and `secret` are constants written in the page, the same
 * for every visitor.
 */
export function yijiangForm(number: string): URLSearchParams {
  return new URLSearchParams({
    _action: 'query', txtIsNumber: '1', 'txtData[txtnumbers]': number, 'txtData[txtphone]': '',
    key: 'yijiangky', secret: 'yijiangkycom', // gitleaks:allow
  });
}

export class YijiangTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session, cookie or account.
    const { response, bytes } = await fetchBounded(yijiangLookupUrl(), { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: YIJIANG_TRACKER, 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: yijiangForm(number).toString() }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: YIJIANG_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: REDIRECTS });
    // An unknown number is HTTP 200 too; a redirect is a moved page.
    if (response.status !== 200) throw new TransportError(PROVIDER, `${PROVIDER} tracking page moved`, { status: response.status });
    return parseYijiang(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeYijiangNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new YijiangTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeYijiangNumber(number))),
  };
};
