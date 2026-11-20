import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeAcplCargoNumber, parseAcplCargo, PROVIDER } from './parser.js';

export { normalizeAcplCargoNumber, parseAcplCargo } from './parser.js';

const ORIGIN = 'https://acplcargo.com';
/** The tracking page, which the requests name as their referrer. */
export const ACPL_CARGO_PAGE = `${ORIGIN}/tracking`;
/** The guest session the page's script opens before its first lookup, set as a cookie. */
export const ACPL_CARGO_SESSION = `${ORIGIN}/bff/api/auth/session`;
/** The lookup the page's script makes for a GC number. */
export const acplCargoLookupUrl = (number: string): string => `${ORIGIN}/bff/api/etrans?${new URLSearchParams({ gcNumber: number })}`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number with HTTP 200; a 404 or 410 is a moved route.
const GONE = [404, 410];
const SESSION_COOKIE = /^bff\.session=([A-Za-z0-9_-]{16,256})$/;
// Bot checks a firewall could put in place of a reply.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|awswaf|<title>\s*(?:Just a moment|Access Denied|Attention Required|Request Rejected)/i;

/** The guest session's cookie from the session reply, or null without one. */
function sessionCookie(response: Response): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    if (SESSION_COOKIE.test(pair)) return pair;
  }
  return null;
}

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `ACPL Cargo answered the ${what} with a browser check`, { cause });
    throw new SchemaError(PROVIDER, `ACPL Cargo returned a ${what} that is not JSON`, { cause });
  }
}

export class AcplCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeAcplCargoNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    // One attempt opens a guest session and looks the number up in it, as the page's script does.
    // The form's arithmetic check is worked in the page alone; the server does not ask for it.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const options = (allow: readonly number[] = []) => ({ provider: PROVIDER, timeoutMs: left(), maxBytes: MAX_BYTES,
        redirect: 'manual' as const, allowHttpStatuses: [...REDIRECTS, ...GONE, ...allow], fetcher: this.options.fetcher });
      const moved = (status: number, what: string) => {
        if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, `ACPL Cargo's ${what} is unavailable`, { status });
      };
      const headers = { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgent, Referer: ACPL_CARGO_PAGE };

      const session = await fetchBounded(ACPL_CARGO_SESSION, { method: 'GET', signal, headers }, options());
      moved(session.response.status, 'guest session');
      const opened = json(decodeText(session.bytes), 'guest session');
      const cookie = sessionCookie(session.response);
      if (!isRecord(opened) || typeof opened.csrfToken !== 'string' || !cookie) throw new SchemaError(PROVIDER, 'ACPL Cargo opened no guest session');

      const lookup = await fetchBounded(acplCargoLookupUrl(number), { method: 'GET', signal, headers: { ...headers, Cookie: cookie } }, options([401]));
      const { status } = lookup.response;
      moved(status, 'tracking lookup');
      // The session the tracker just opened was refused: a fresh one is the only remedy.
      if (status === 401) throw new IndeterminateError(PROVIDER, 'ACPL Cargo refused its own guest session', { status });
      return parseAcplCargo(json(decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim(), 'tracking reply'), number);
    };
    // An attempt that fails to reach ACPL Cargo, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AcplCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
