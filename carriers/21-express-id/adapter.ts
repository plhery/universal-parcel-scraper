import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAX_BYTES, normalizeTwentyOneExpressNumber, parseTwentyOneExpress, PROVIDER } from './parser.js';

export { normalizeTwentyOneExpressNumber, parseTwentyOneExpress } from './parser.js';

const ORIGIN = 'https://21express.co.id';
/** The tracking page, which carries the form's token and opens the session it belongs to. */
export const TWENTY_ONE_EXPRESS_PAGE = `${ORIGIN}/track`;
/** The lookup the page makes for a waybill's rows. */
export const TWENTY_ONE_EXPRESS_LOOKUP = `${ORIGIN}/detail-tracking`;
const PAGE_BYTES = 512_000;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Yii's answer to a post whose token does not match the session.
const REFUSED = 400;
// The form's token, as the page writes it in its meta tag and in the form's hidden field.
const TOKEN = /<meta\s+name="csrf-token"\s+content="([A-Za-z0-9_=-]{16,200})"|name="_csrf"\s+value="([A-Za-z0-9_=-]{16,200})"/;
// The session and token cookies the page sets.
const COOKIE = /^(?:PHPSESSID|_csrf)=[^\s;,]{1,512}/;
// Bot checks a firewall could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|awswaf|<title>\s*(?:Just a moment|Access Denied|Attention Required|Request Rejected)/i;

/**
 * The same failure without the request and response details fetchBounded attaches: they hold
 * the session cookie and the form's token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class TwentyOneExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeTwentyOneExpressNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    // The page's reCAPTCHA only gates its button: the lookup checks the form's token against the
    // session the page opened, and nothing else.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const unavailable = (status: number, what: string) => {
        if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, `21 Express's ${what} is unavailable`, { status });
      };
      try {
        const page = await fetchBounded(TWENTY_ONE_EXPRESS_PAGE, { method: 'GET', signal, headers: {
          Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent } }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: PAGE_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
        unavailable(page.response.status, 'tracking page');
        const html = decodeText(page.bytes);
        const token = TOKEN.exec(html);
        if (!token) {
          if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '21 Express answered with a browser check');
          throw new SchemaError(PROVIDER, '21 Express\'s tracking page has no form token');
        }
        const cookie = page.response.headers.getSetCookie().map((header) => COOKIE.exec(header)?.[0]).filter(Boolean).join('; ');
        if (!cookie) throw new IndeterminateError(PROVIDER, '21 Express did not open a tracking session', { reason: 'session_rejected' });
        signal.throwIfAborted();
        const lookup = await fetchBounded(TWENTY_ONE_EXPRESS_LOOKUP, { method: 'POST', signal, headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': userAgent, Referer: TWENTY_ONE_EXPRESS_PAGE, Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie },
        body: new URLSearchParams({ _csrf: token[1] ?? token[2]!, rec: number }).toString() }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, REFUSED], fetcher: this.options.fetcher });
        unavailable(lookup.response.status, 'tracking lookup');
        const text = decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim();
        if (lookup.response.status === REFUSED) {
          throw new IndeterminateError(PROVIDER, '21 Express did not accept the tracking session', { reason: 'session_rejected' });
        }
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch (cause) {
          if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '21 Express answered with a browser check', { cause });
          throw new SchemaError(PROVIDER, '21 Express returned a reply that is not JSON', { cause });
        }
        return parseTwentyOneExpress(data, number);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    // An attempt that fails to reach 21 Express, or hangs, gets one more: the first gets half of
    // the budget, so the retry fits in the rest.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TwentyOneExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
