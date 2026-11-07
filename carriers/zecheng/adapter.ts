import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeZechengNumber, parseZecheng, PROVIDER, ZECHENG_MAX_BYTES } from './parser.js';

/** The tracking page on api.zecwl.com, which fills its form with the numbers in its address. */
export const ZECHENG_PAGE = 'https://api.zecwl.com/index/tracknumber/track';
/** The lookup that page makes. */
export const ZECHENG_API = 'https://api.zecwl.com/index/tracknumber/getTrackingByNos';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** The reply's JSON. A known number's array comes encoded once more, as a JSON string. */
function json(body: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
    return typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch (cause) {
    if (typeof payload === 'string') throw new SchemaError(PROVIDER, 'Zecheng returned a reply that is not JSON', { cause });
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Zecheng answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Zecheng returned a reply that is not JSON', { cause });
  }
}

export class ZechengTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZechengNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${ZECHENG_API}?nos=${number}`, { method: 'GET', signal, headers: {
        // The page's language.
        Accept: 'application/json', 'Accept-Language': 'zh-CN', Referer: `${ZECHENG_PAGE}?nos=${number}`,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZECHENG_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The lookup answers every number with HTTP 200; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Zecheng tracking lookup moved', { status: response.status });
      return parseZecheng(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'zecheng', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZechengTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zecheng', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeZechengNumber(number))),
  };
};
