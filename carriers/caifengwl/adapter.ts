import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CAIFENG_MAX_BYTES, CARRIER, normalizeCaifengNumber, parseCaifeng, PROVIDER } from './parser.js';

export { caifengWording, normalizeCaifengNumber, parseCaifeng } from './parser.js';

/** The firm's tracking page, plain HTTP only, whose form sends the number to the lookup below. */
export const CAIFENG_PAGE = 'http://www.caifengwl.com/list-a1002002.html';
/** The waybill lookup of the TMS platform the firm runs on, under the firm's own database. */
export const CAIFENG_LOOKUP = 'https://tms.gdonetrue.com/weixin/LogisticTrace.ashx';
const DATABASE = 'ausoft_caifeng';
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The lookup for one number under the firm's database. */
export function caifengLookupUrl(number: string): string {
  return `${CAIFENG_LOOKUP}?${new URLSearchParams({ database: DATABASE, no: number })}`;
}

export class CaifengTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The database and the number alone, as the tracking page asks: no session, cookie or account.
    const { response, bytes } = await fetchBounded(caifengLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', Origin: 'http://www.caifengwl.com', Referer: CAIFENG_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: CAIFENG_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 403, 404, 429, 503] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    const body = decodeText(bytes);
    if (response.status !== 200) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Caifeng Logistics answered with a verification page');
      throw new TransportError(PROVIDER, 'Caifeng Logistics tracking is unavailable', { status: response.status });
    }
    return parseCaifeng(body, number, Date.now());
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCaifengNumber(raw);
    // A read that fails to reach the platform, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CaifengTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
