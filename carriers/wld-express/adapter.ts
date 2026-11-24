import { createHash } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeWldNumber, parseWld, PROVIDER, WLD_MAX_BYTES } from './parser.js';

/** The endpoint WLD's track query page posts to. */
export const WLD_API = 'https://wld-exp.com/api/re-toms/v1';
const WLD_PAGE = 'https://wld-exp.com/';
const METHOD = 'getTrackInfoOutside';
/** The key the page's script signs every request with; every visitor gets the same one. */
const SIGNING_KEY = 'EYOU7RF4'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|acw_sc__v2|aliyun_waf|waf\.tencent|captcha|人机验证|滑动验证|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

/**
 * The page's token for a guest: twenty hex digits from the MD5 of the method,
 * the timestamp, the signing key and the customer code and login key a guest
 * does not have, which the script writes as "undefined".
 */
export function wldToken(timestamp: number): string {
  return createHash('md5').update(`${METHOD}${timestamp}undefined${SIGNING_KEY}undefined`).digest('hex').slice(8, 28);
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'WLD Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'WLD Express returned a reply that is not JSON', { cause });
  }
}

export class WldTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWldNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request for a guest, in English.
      const timestamp = Date.now();
      const body = JSON.stringify({ method: METHOD, param: { codes: number, noUserCode: '1' },
        timestamp, token: wldToken(timestamp), lang: 'en_US' });
      const { response, bytes } = await fetchBounded(WLD_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: WLD_PAGE.slice(0, -1),
        Referer: WLD_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: WLD_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const text = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'WLD Express redirected its tracking lookup', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'WLD Express refused the lookup', { status: 403 });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'WLD Express tracking lookup is unavailable', { status: response.status });
      return parseWld(json(text), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'wld-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WldTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'wld-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
