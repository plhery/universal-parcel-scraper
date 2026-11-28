import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CARRIER, LXS_MAX_BYTES, normalizeLxsNumber, parseLxs, PROVIDER } from './parser.js';

export { normalizeLxsNumber, parseLxs } from './parser.js';

/** Lanqiao's tracking platform, on which the firm's site's 物流查询 link opens the firm's page. */
export const LXS_PLATFORM = 'https://www.1008656.com/index.aspx';
// The firm's company id on the platform, from that link.
const COMPANY_ID = '73320';
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|安全威胁|Access denied|访问被拒绝/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The firm's tracking page for one number, which looks it up on load. */
export function lxsPageUrl(number: string): string {
  return `${LXS_PLATFORM}?${new URLSearchParams({ id: COMPANY_ID, keyword: number })}`;
}

/** The lookup that page sends for one number under the firm's company id. */
export function lxsLookupUrl(number: string): string {
  return `${LXS_PLATFORM}?${new URLSearchParams({ do: 'waybill', id: COMPANY_ID, keyword: number })}`;
}

export class LxsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // An empty POST, as the page sends it: no session, cookie or account.
    const { response, bytes } = await fetchBounded(lxsLookupUrl(number), { method: 'POST', body: '', signal, headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.1008656.com', Referer: lxsPageUrl(number), 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: LXS_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 403, 404, 418, 429, 500, 502, 503] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    const body = decodeText(bytes);
    if (response.status !== 200) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Longxinshun Logistics answered with a verification page');
      // An unknown number is HTTP 200 too; a redirect or a missing page is a moved route.
      throw new TransportError(PROVIDER, 'Longxinshun Logistics tracking is unavailable', { status: response.status });
    }
    return parseLxs(body, number, Date.now());
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeLxsNumber(raw);
    // A read that fails to reach the platform, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LxsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
