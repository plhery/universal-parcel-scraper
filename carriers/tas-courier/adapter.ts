import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTasBlocked, normalizeTasNumber, parseTas, PROVIDER, TAS_MAX_BYTES, TAS_RESULT, TAS_SEARCH, tasQueryNumber } from './parser.js';

export { normalizeTasNumber, parseTas } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;
// PHP's session cookie, which the voucher list reads the search from.
const SESSION_COOKIE = /^PHPSESSID=[A-Za-z0-9,-]{1,128}/;

/**
 * The same failure without the request and response details fetchBounded attaches: they hold the
 * session cookie.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class TasCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /**
   * The voucher search's two requests: its page, which opens a session, then the list the page
   * loads into itself, in that session. No token or CAPTCHA.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const voucher = tasQueryNumber(number);
    const page = `${TAS_SEARCH}?${new URLSearchParams({ pcode: 'SEARCHVOUCHER', r18p01: voucher })}`;
    const get = (url: string, headers: Record<string, string>) => fetchBounded(url, { method: 'GET', signal, headers: {
      'User-Agent': userAgentOf(this.options.userAgent), 'Accept-Language': 'el', ...headers,
    } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: TAS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
    const answered = (response: Response, body: string, what: string) => {
      const { status } = response;
      if (status === 403) {
        if (isTasBlocked(body)) throw new ChallengeError(PROVIDER, 'TAS Courier answered with a browser check', { status });
        throw new ChallengeError(PROVIDER, `TAS Courier refused its ${what}`, { status });
      }
      if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
      if (status !== 200) throw new TransportError(PROVIDER, `TAS Courier's ${what} is unavailable`, { status });
    };
    try {
      const search = await get(page, { Accept: 'text/html,application/xhtml+xml' });
      answered(search.response, decodeText(search.bytes), 'voucher search');
      const session = search.response.headers.getSetCookie().map((cookie) => SESSION_COOKIE.exec(cookie)?.[0]).find(Boolean);
      if (!session) throw new IndeterminateError(PROVIDER, 'TAS Courier did not open a search session', { reason: 'session_rejected' });
      signal.throwIfAborted();
      const list = await get(`${TAS_RESULT}?${new URLSearchParams({ add_event: '1', r18p01: voucher, having: '1' })}`, {
        Accept: 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Cookie: session, Referer: page });
      const body = decodeText(list.bytes);
      answered(list.response, body, 'voucher list');
      return parseTas(body, number);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTasNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers TAS Courier for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new TasCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
