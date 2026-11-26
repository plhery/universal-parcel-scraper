import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  JOMKIRIM_FORM, JOMKIRIM_MAX_BYTES, jomkirimTrackingUrl, normalizeJomkirimNumber, parseJomkirim, PROVIDER,
  readJomkirimForm,
} from './parser.js';

export { jomkirimTrackingUrl, normalizeJomkirimNumber, parseJomkirim } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 410];
// Laravel's session cookie, which carries the notice for the code the session asked about.
const SESSION_COOKIE = /^jomkirim_courier_session=[^\s;,]{1,512}/;
const DEFAULT_BUDGET_MS = 15_000;

export class JomkirimTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const get = (url: string, cookie?: string) => fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent), ...(cookie ? { Cookie: cookie } : {}),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: JOMKIRIM_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
    const page = await get(jomkirimTrackingUrl(number));
    const { status } = page.response;
    if (status === 403) throw new ChallengeError(PROVIDER, 'Jomkirim refused the tracking page', { status });
    if (UNAVAILABLE.includes(status)) throw new TransportError(PROVIDER, 'Jomkirim\'s tracking page is unavailable', { status });
    if (!REDIRECTS.includes(status)) return parseJomkirim(decodeText(page.bytes), number);

    // A code the tracker has no shipment under goes back to the form, which shows the notice for
    // that session. A redirect anywhere else, such as its login page, is a moved route.
    const location = page.response.headers.get('location');
    const target = location ? URL.parse(location, JOMKIRIM_FORM) : null;
    if (target?.href !== JOMKIRIM_FORM) throw new TransportError(PROVIDER, 'Jomkirim redirected its tracking page', { status });
    const session = page.response.headers.getSetCookie().map((cookie) => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
    if (!session) throw new IndeterminateError(PROVIDER, 'Jomkirim did not open a session for its notice', { reason: 'session_rejected' });
    signal.throwIfAborted();
    const form = await get(JOMKIRIM_FORM, session);
    if (form.response.status === 403) throw new ChallengeError(PROVIDER, 'Jomkirim refused its tracking form', { status: 403 });
    if (form.response.status !== 200) throw new TransportError(PROVIDER, 'Jomkirim moved its tracking form', { status: form.response.status });
    return readJomkirimForm(decodeText(form.bytes));
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJomkirimNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more with a new session:
    // the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JomkirimTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
