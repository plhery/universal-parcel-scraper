import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSkifNumber, parseSkif, PROVIDER, SKIF_MAX_BYTES, SKIF_PAGE_MAX_BYTES } from './parser.js';

const ORIGIN = 'https://www.skif-cargo.ru';
/** The tracking page, which sets the cookie the account check asks for. */
export const SKIF_PAGE = `${ORIGIN}/tracking/`;
/** The account check the page's script makes on load, which issues an anonymous visitor's CSRF cookie. */
export const SKIF_PROFILE = `${ORIGIN}/getProfile/`;
/** The lookup the page's script posts the number to: the page's own address. */
export const SKIF_LOOKUP = SKIF_PAGE;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number with HTTP 200; a 404 or 410 is a moved route.
const GONE = [404, 410];
const COOKIE = /^[A-Za-z0-9_-]{1,64}=[^\s;,]{1,256}$/;
const TOKEN = /^[A-Za-z0-9]{32,64}$/;
// Django's refusal of a request without the CSRF cookie its token belongs to.
const REFUSED_SESSION = /Ошибка проверки CSRF|CSRF verification failed/i;
// Bot checks a firewall could put in place of the page or a reply. The tracking page itself
// loads a captcha for its callback form.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|ddos-guard|__qrator|servicepipe|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;

/** The cookies a reply sets, by name; a cookie it clears, with an empty value, is dropped. */
function setCookies(response: Response, jar: Map<string, string>): void {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    if (COOKIE.test(pair) && !/^""$/.test(pair.slice(separator + 1))) jar.set(name, pair.slice(separator + 1));
    else if (separator > 0) jar.delete(name);
  }
}

const cookieHeader = (jar: Map<string, string>) => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

/** A bot check in place of a page or reply, not the tracker's own page with its callback form's captcha. */
function isChallenge(body: string): boolean {
  return !/name="csrf-token"/.test(body) && CHALLENGE.test(body.slice(0, 64_000));
}

export class SkifTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSkifNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    // One attempt opens the page, makes its account check and posts the number with the
    // check's CSRF token, as the page's script does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const jar = new Map<string, string>();
      const options = (maxBytes: number) => ({ provider: PROVIDER, timeoutMs: left(), maxBytes, redirect: 'manual' as const,
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      const moved = (status: number, what: string) => {
        if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, `Skif-Cargo ${what} is unavailable`, { status });
      };

      const page = await fetchBounded(SKIF_PAGE, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent,
      } }, options(SKIF_PAGE_MAX_BYTES));
      moved(page.response.status, 'tracking page');
      if (isChallenge(decodeText(page.bytes))) throw new ChallengeError(PROVIDER, 'Skif-Cargo answered the tracking page with a browser check');
      setCookies(page.response, jar);

      const profile = await fetchBounded(SKIF_PROFILE, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgent, Cookie: cookieHeader(jar), Referer: SKIF_PAGE,
      } }, options(SKIF_MAX_BYTES));
      moved(profile.response.status, 'account check');
      if (isChallenge(decodeText(profile.bytes))) throw new ChallengeError(PROVIDER, 'Skif-Cargo answered the account check with a browser check');
      setCookies(profile.response, jar);
      const token = jar.get('csrftoken');
      if (!token || !TOKEN.test(token)) throw new SchemaError(PROVIDER, 'Skif-Cargo opened no session for its lookup');

      // The page's own request: the number as the whole body, and no captcha answer.
      const lookup = await fetchBounded(SKIF_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent,
        Cookie: cookieHeader(jar), 'X-CSRFToken': token, Origin: ORIGIN, Referer: SKIF_PAGE,
      }, body: number }, { ...options(SKIF_MAX_BYTES), allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      const { status } = lookup.response;
      moved(status, 'tracking lookup');
      const body = decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim();
      if (status === 403) {
        // The session the page just opened was refused: a fresh one is the only remedy.
        if (REFUSED_SESSION.test(body.slice(0, 8_000))) throw new IndeterminateError(PROVIDER, 'Skif-Cargo refused the tracking page’s session', { status });
        throw new ChallengeError(PROVIDER, 'Skif-Cargo refused the lookup', { status });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (isChallenge(body)) throw new ChallengeError(PROVIDER, 'Skif-Cargo answered the lookup with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'Skif-Cargo returned a reply that is not JSON', { cause });
      }
      return parseSkif(payload, number);
    };
    // An attempt that fails to reach Skif-Cargo, or hangs, gets one more in a new
    // session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'skif-cargo', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkifTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skif-cargo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
