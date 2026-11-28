import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { CARRIER, normalizeXsbNumber, parseXsb, PROVIDER, XSB_MAX_BYTES } from './parser.js';

export { normalizeXsbNumber, parseXsb, xsbWording } from './parser.js';

/** The firm's site, plain HTTP only, which serves each number's tracking page at its own address. */
export const XSB_SITE = 'http://www.xsb56.cn/';
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The tracking page for one number, as the site's search box opens it. */
export function xsbPageUrl(number: string): string {
  return `${XSB_SITE}Tracking_${encodeURIComponent(number)}.shtml`;
}

export class XsbTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page alone: no session, cookie or account.
    const { response, bytes } = await fetchBounded(xsbPageUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: `${XSB_SITE}Tracking.shtml`,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: XSB_MAX_BYTES, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 403, 404, 429, 500, 503] });
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
    const body = decodeText(bytes);
    if (response.status !== 200) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Xinshengbang Logistics answered with a verification page');
      // An unknown number is HTTP 200 too; a redirect or a missing page is a moved route.
      throw new TransportError(PROVIDER, 'Xinshengbang Logistics tracking is unavailable', { status: response.status });
    }
    return parseXsb(body, number, Date.now());
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeXsbNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XsbTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
