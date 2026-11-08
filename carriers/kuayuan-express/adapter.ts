import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { KUAYUAN_MAX_BYTES, normalizeKuayuanNumber, parseKuayuan, PROVIDER } from './parser.js';

/** The endpoint the tracking form on Kuayuan's home page posts to. */
export const KUAYUAN_API = 'https://kuayuanexpress.com.cn/api/re-toms/v1';
const KUAYUAN_PAGE = 'https://www.kuayuanexpress.com.cn/';
/** The token the home page's script sends with every lookup; every visitor gets the same one. */
const TOKEN = 'd68d8e7efc586bd8806b'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|acw_sc__v2|aliyun_waf|waf\.tencent|captcha|人机验证|滑动验证|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Kuayuan Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Kuayuan Express returned a reply that is not JSON', { cause });
  }
}

export class KuayuanTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKuayuanNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request, in English.
      const body = JSON.stringify({ method: 'getTrackInfoOutside', param: { codes: number, noUserCode: '1' },
        timestamp: Date.now(), token: TOKEN, lang: 'en_US' });
      const { response, bytes } = await fetchBounded(KUAYUAN_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: KUAYUAN_PAGE.slice(0, -1),
        Referer: KUAYUAN_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: KUAYUAN_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const text = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Kuayuan Express redirected its tracking lookup', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Kuayuan Express refused the lookup', { status: 403 });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Kuayuan Express tracking lookup is unavailable', { status: response.status });
      return parseKuayuan(json(text), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'kuayuan-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KuayuanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kuayuan-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKuayuanNumber(number))),
  };
};
