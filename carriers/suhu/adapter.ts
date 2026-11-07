import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSuhuNumber, parseSuhu, parseSuhuNonce, PROVIDER, SUHU_MAX_BYTES, SUHU_PAGE_MAX_BYTES } from './parser.js';

/** The home page, whose tracking form posts the number with a nonce. */
export const SUHU_PAGE = 'https://www.suhusupplychain.com/';
/** The WordPress endpoint that form posts to. */
export const SUHU_API = 'https://www.suhusupplychain.com/wp-admin/admin-ajax.php';
/** The tracking plugin's action. */
export const SUHU_ACTION = 'suhu_get_tracking_info';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Suhu Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Suhu Express returned a reply that is not JSON', { cause });
  }
}

export class SuhuTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSuhuNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const options = (maxBytes: number, allowed: readonly number[]) => ({ provider: PROVIDER, maxBytes, redirect: 'manual' as const,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...allowed] });
      const userAgent = userAgentOf(this.options.userAgent);
      // The home page carries the nonce the form sends. It is read fresh for every lookup.
      const page = await fetchBounded(SUHU_PAGE, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'User-Agent': userAgent,
      } }, options(SUHU_PAGE_MAX_BYTES, [404, 410]));
      if (page.response.status !== 200) throw new TransportError(PROVIDER, 'Suhu Express home page is unavailable');
      const nonce = parseSuhuNonce(decodeText(page.bytes));
      // English wording for the scans; the form's own default is Chinese.
      const { response, bytes } = await fetchBounded(SUHU_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', Referer: SUHU_PAGE, 'User-Agent': userAgent,
      }, body: new URLSearchParams({ action: SUHU_ACTION, tracking_numbers: number, language: 'en', nonce }).toString() },
      options(SUHU_MAX_BYTES, [400, 403, 404, 410]));
      const text = decodeText(bytes);
      // WordPress answers a nonce it does not accept with HTTP 403 and `-1`, and
      // an action no plugin registers with HTTP 400 and `0`; a 404 is a moved route.
      if (response.status === 403 && text.trim() === '-1') {
        throw new IndeterminateError(PROVIDER, 'Suhu Express refused the home page’s nonce', { reason: 'nonce_expired' });
      }
      if (response.status === 403 && CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Suhu Express answered with a browser check');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Suhu Express tracking lookup is unavailable', { status: response.status });
      return parseSuhu(json(text), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'suhu', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SuhuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'suhu', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSuhuNumber(number))),
  };
};
