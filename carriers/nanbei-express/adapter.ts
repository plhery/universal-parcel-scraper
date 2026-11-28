import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, NANBEI_MAX_BYTES, normalizeNanbeiNumber, parseNanbei, PROVIDER } from './parser.js';

export { nanbeiWording, normalizeNanbeiNumber, parseNanbei } from './parser.js';

/** The company's site, plain HTTP only, whose home page holds the tracking form. */
export const NANBEI_SITE = 'http://www.nbky.com.cn/';
/** The route service of the Yilian (蚁链) platform the form posts the number to. */
export const NANBEI_ROUTES = 'https://tj.yilian56.com.cn/tms-ylpt/open/followUp/findEventRouteByOrderNo';
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
const DEFAULT_BUDGET_MS = 20_000;

export class NanbeiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, as the home page's form posts it: no session, cookie or account.
    const { response, bytes } = await fetchBounded(NANBEI_ROUTES, { method: 'POST', signal, body: new URLSearchParams({ orderNo: number }),
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'http://www.nbky.com.cn', Referer: NANBEI_SITE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: NANBEI_MAX_BYTES, timeoutMs, redirect: 'manual',
      allowHttpStatuses: [301, 302, 303, 307, 308, 403, 429, 503] });
    const body = decodeText(bytes);
    // A sentence may mention a pickup code, so only a refusal or a reply that is not JSON is read for a bot check.
    if (response.status !== 200 || !body.trimStart().startsWith('{')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Nanbei Express answered with a verification page');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Nanbei Express tracking is unavailable', { status: response.status });
      throw new SchemaError(PROVIDER, 'Nanbei Express answered with something other than its route service');
    }
    return parseNanbei(body, number);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeNanbeiNumber(raw);
    // A read that fails to reach the platform, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NanbeiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
