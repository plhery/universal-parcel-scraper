import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeYadexNumber, parseYadex, PROVIDER, YADEX_MAX_BYTES } from './parser.js';

/** The site, which answers plain HTTP only, on port 9000 where www.yadex.com.cn redirects. */
export const YADEX_ORIGIN = 'http://yadex.com.cn:9000';
/** The waybill page, whose script asks the timeline for the number in its address. */
export const YADEX_PAGE = `${YADEX_ORIGIN}/index/waybill`;
/** The timeline the page appends: an HTML fragment, or one sentence for a number without records. */
export const YADEX_TIMELINE = `${YADEX_ORIGIN}/index/waybill/call`;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|验证码|滑块|Access denied|访问被拒绝/i;
// A whole page rather than the fragment: an error page, a login page or a firewall's.
const PAGE = /<html|<title/i;

export class YadexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeYadexNumber(raw);
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The number alone, as the page's script asks it: no session, cookie or account.
      const { response, bytes } = await fetchBounded(`${YADEX_TIMELINE}?nu=${encodeURIComponent(number)}`, { method: 'GET', signal,
        headers: {
          Accept: 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
          Referer: `${YADEX_PAGE}?nu=${encodeURIComponent(number)}`, 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: YADEX_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(remainingMs)), redirect: 'manual', allowHttpStatuses: [403, 503] });
      const body = decodeText(bytes);
      const head = body.slice(0, 64_000);
      // A row may mention a pickup code, so only a whole page or a refusal is read for a bot check.
      if (response.status !== 200 || PAGE.test(head)) {
        if (CHALLENGE.test(head)) throw new ChallengeError(PROVIDER, 'Yadex answered with a verification page');
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Yadex tracking is unavailable', { status: response.status });
        throw new SchemaError(PROVIDER, 'Yadex answered with a page instead of its timeline');
      }
      return parseYadex(body, number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new YadexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
