import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MILAHA_MAX_BYTES, milahaQuery, milahaResult, parseMilahaDetails, parseMilahaMoves, PROVIDER } from './parser.js';

const ORIGIN = 'https://erp-qnl.solverminds.net/ecomonline';
/** Milaha's e-commerce home page, which opens the anonymous session its tracker needs. */
export const MILAHA_HOME = `${ORIGIN}/`;
/** The home page's tracking form, which the session must post before the tracker answers. */
export const MILAHA_FORM = `${ORIGIN}/tracking.do`;
/** The booking and its containers the tracking page asks for, and each container's moves. */
export const MILAHA_DETAILS = `${ORIGIN}/TrackingDetails.do`;
export const MILAHA_MOVES = `${ORIGIN}/ecomAjax`;
const REDIRECTS = [301, 302, 303, 307, 308];
const SESSION = /^JSESSIONID=[A-Za-z0-9._-]{8,200}$/;
// Bot checks a CDN or firewall could put in place of a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;
// A booking's containers whose moves are read; the others keep the latest move the booking lists.
const MOVE_PANELS = 12;

/** The booking and containers for a number, as the tracking page asks for them. */
export function milahaDetailsUrl(number: string, now = Date.now()): string {
  return `${MILAHA_DETAILS}?${new URLSearchParams({ Mdl: 'containernos', MdlNo: number, ldate: String(now), tmp: '', trackingviahome: 'Y' })}`;
}

/** A container's moves under its booking, as the page's "View details" asks for them. */
export function milahaMovesUrl(container: string, booking: string, now = Date.now()): string {
  return `${MILAHA_MOVES}?${new URLSearchParams({ type: 'containermovement', containerNo: container, bookNo: booking, date: String(now), tmp: '' })}`;
}

/** The anonymous session the home page opens. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    if (SESSION.test(pair)) return pair;
  }
  throw new IndeterminateError(PROVIDER, 'Milaha did not open an anonymous session', { reason: 'session_rejected' });
}

export class MilahaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const query = milahaQuery(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      let cookie = '';
      const request = async (url: string, init: RequestInit, what: string) => {
        signal.throwIfAborted();
        const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
          Accept: 'text/html', 'User-Agent': userAgent, ...(cookie ? { Cookie: cookie, Referer: MILAHA_FORM } : {}), ...init.headers,
        } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: MILAHA_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429], fetcher: this.options.fetcher });
        const status = response.status;
        const body = decodeText(bytes);
        if (status === 429) throw new RateLimitedError(PROVIDER);
        if (status === 403 || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `Milaha refused its ${what}`, { status });
        // The tracker sends a session it does not know to its expiry page.
        if (REDIRECTS.includes(status) && /SessionExpired/i.test(response.headers.get('location') ?? '')) {
          throw new IndeterminateError(PROVIDER, 'Milaha did not accept the tracking session', { reason: 'session_rejected' });
        }
        if (status !== 200) throw new TransportError(PROVIDER, `Milaha ${what} is unavailable`, { status });
        return { response, body };
      };

      const home = await request(MILAHA_HOME, { method: 'GET' }, 'home page');
      cookie = sessionCookie(home.response);
      // The form's picture code is checked only in the page; the server takes the form without it.
      await request(MILAHA_FORM, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tracktype: 'logintracking', logintracno: query.number, captcha: '' }).toString() }, 'tracking form');
      const details = await request(milahaDetailsUrl(query.number), { method: 'POST' }, 'tracking lookup');
      const containers = parseMilahaDetails(details.body, query);
      const read = containers.slice(0, MOVE_PANELS);
      const moves = await Promise.all(read.map(async (container) => {
        const panel = await request(milahaMovesUrl(container.number, container.booking), { method: 'POST' }, 'container moves');
        const events = parseMilahaMoves(panel.body);
        // A container listed without moves keeps the latest move the booking shows for it.
        return events.length ? events : container.latest ? [container.latest] : [];
      }));
      const rest = containers.slice(MOVE_PANELS).map((container): CarrierEvent[] => (container.latest ? [container.latest] : []));
      return milahaResult([...moves, ...rest], rest.length > 0);
    };
    // A failed container read ends the others still running, so none outlives its attempt.
    const ending = (signal: AbortSignal, timeoutMs: number) => {
      const sibling = new AbortController();
      return attempt(AbortSignal.any([signal, sibling.signal]), timeoutMs).finally(() => sibling.abort());
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more in a new session:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'milaha', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => ending(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => ending(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MilahaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'milaha', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
