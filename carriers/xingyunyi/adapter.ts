import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeXingyunyiNumber, parseXingyunyi, PROVIDER, XINGYUNYI_MAX_BYTES } from './parser.js';

/** The service XingYunYi's tracking page posts to. */
export const XINGYUNYI_API = 'https://customerservice.xingyunyi.cn/api/Order/GetTracking';
const XINGYUNYI_PAGE = 'https://www.xingyunyi.com/';
/** The token the tracking page's script sends with every lookup; every visitor gets the same one. */
const PAGE_TOKEN = '29301AD4500BB72059677F1EF6198CFD'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|acw_sc__v2|aliyun_waf|waf\.tencent|captcha|人机验证|滑动验证|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'XingYunYi answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'XingYunYi returned a reply that is not JSON', { cause });
  }
}

export class XingyunyiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeXingyunyiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request, with the number as the only one asked.
      const { response, bytes } = await fetchBounded(XINGYUNYI_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', Authorization: `token ${PAGE_TOKEN}`, 'Content-Type': 'application/json',
        Origin: XINGYUNYI_PAGE.slice(0, -1), Referer: XINGYUNYI_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ Numbers: [number] }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: XINGYUNYI_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const text = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'XingYunYi redirected its tracking lookup', { status: response.status });
      // The service refuses a request with another token with a bare 403, as a firewall would.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'XingYunYi refused the lookup', { status: 403, reason: 'api_denied' });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'XingYunYi tracking lookup is unavailable', { status: response.status });
      return parseXingyunyi(json(text), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'xingyunyi', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XingyunyiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'xingyunyi', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
