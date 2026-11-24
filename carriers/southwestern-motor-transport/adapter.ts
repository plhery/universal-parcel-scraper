import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSmtNumber, parseSmtSession, parseSmtTrace, PROVIDER, SMT_MAX_BYTES, smtJson } from './parser.js';

export { normalizeSmtNumber, parseSmtSession, parseSmtTrace } from './parser.js';

/** The Profound UI program SMT's Shipment Tracing page runs, without an account. */
export const SMT_SCREEN = 'https://profoundui.smtl.com/profoundui/PUI0001200.pgm';
const START_PAGE = 'https://profoundui.smtl.com/profoundui/start?pgm=profoundui/mwp705c&p1=0&l1=1&p2=none&l2=4&p3=none&l3=4';
const DEFAULT_BUDGET_MS = 20_000;
// Closing the session frees the server's job at once instead of after its fifteen-minute timeout.
const CLOSE_MS = 2_000;

export class SmtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One form post to the program, read as its screen's JSON. */
  private async post(url: string, form: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: START_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams(form).toString() }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SMT_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Southwestern Motor Transport refused the lookup', { status });
    if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
    // A redirect or a missing program is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Southwestern Motor Transport tracing is unavailable', { status });
    return smtJson(body);
  }

  /** Opens the trace screen, traces the PRO on it, then closes the session. No account, cookie or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const psid = parseSmtSession(await this.post(SMT_SCREEN, { program: 'MWP705C', library: 'PROFOUNDUI', init: '1' }, signal, left()));
    const session = `${SMT_SCREEN}/${psid}`;
    try {
      return parseSmtTrace(await this.post(session, { 'TRACEBY.FHPRO': number, 'TRACEBY.TABINDEX': '0' }, signal, left()), number);
    } finally {
      await this.close(session, signal, Math.min(CLOSE_MS, left()));
    }
  }

  /** Ends the session as the page does when it closes. Its answer does not matter. */
  private async close(session: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) return;
    try {
      await fetchBounded(session, { method: 'POST', signal, headers: {
        'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: 'shutdown=1' }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SMT_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpError: true,
      });
    } catch {
      // The server ends an abandoned session on its own.
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSmtNumber(raw);
    // A read that fails to reach the tracker, or hangs, is made once more on a new session: the
    // first try gets half of the budget. An HTTP status or a screen is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: an unknown PRO gets the same empty screen as one the trace cannot show, and
// SMT's bare digits are a shape many carriers share, so no rule offers it to preflight.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new SmtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
