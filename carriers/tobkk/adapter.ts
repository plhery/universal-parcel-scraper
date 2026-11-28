import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeTobkkNumber, parseTobkk, PROVIDER, TOBKK_MAX_BYTES } from './parser.js';

export { normalizeTobkkNumber, parseTobkk } from './parser.js';

/** The Chinese tracking page, whose form sends the number back to it as `order_num`. */
export const TOBKK_TRACKING = 'https://www.tobkk.cn/track.php';
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
const DEFAULT_BUDGET_MS = 20_000;

export const tobkkTrackingUrl = (number: string): string => `${TOBKK_TRACKING}?order_num=${encodeURIComponent(number)}`;

export class TobkkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The form's GET, with the number alone: no session, cookie or account.
    const { response, bytes } = await fetchBounded(tobkkTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: TOBKK_MAX_BYTES, timeoutMs, redirect: 'manual',
      allowHttpStatuses: [301, 302, 303, 307, 308, 403, 429, 503] });
    const body = decodeText(bytes);
    // A scan may mention a pickup code, so only a refusal or a page without the tracking form is read for a bot check.
    if (response.status !== 200 || !body.includes('name="order_num"')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Thai Bear answered with a verification page');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Thai Bear tracking is unavailable', { status: response.status });
      throw new SchemaError(PROVIDER, 'Thai Bear answered with a page other than its tracking page');
    }
    return parseTobkk(body, number);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeTobkkNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TobkkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
