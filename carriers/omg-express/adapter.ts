import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeOmgExpressNumber, OMG_EXPRESS_MAX_BYTES, parseOmgExpress, PROVIDER } from './parser.js';

export { normalizeOmgExpressNumber, parseOmgExpress } from './parser.js';

/** The tracking page, which renders a waybill's timeline on the server at `/tracking/<number>`. */
export const OMG_EXPRESS_TRACKING = 'https://omg-exp.com/tracking';
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
const DEFAULT_BUDGET_MS = 20_000;

export const omgExpressTrackingUrl = (number: string): string => `${OMG_EXPRESS_TRACKING}/${encodeURIComponent(number)}`;

export class OmgExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page alone, as a browser opens it: no session, cookie or account.
    const { response, bytes } = await fetchBounded(omgExpressTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: OMG_EXPRESS_MAX_BYTES, timeoutMs, redirect: 'manual',
      allowHttpStatuses: [301, 302, 303, 307, 308, 403, 429, 503] });
    const body = decodeText(bytes);
    // The timeline's wording is the courier's and may name a pickup code, so only a refusal or a page
    // without the site's server data is read for a bot check.
    if (response.status !== 200 || !body.includes('self.__next_f')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'OMG Express answered with a verification page');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'OMG Express tracking is unavailable', { status: response.status });
      throw new SchemaError(PROVIDER, 'OMG Express answered with a page other than its tracking page');
    }
    return parseOmgExpress(body, number);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeOmgExpressNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OmgExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
