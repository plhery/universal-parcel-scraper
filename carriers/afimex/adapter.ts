import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, MaintenanceError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  AFIMEX_MAX_BYTES, AFIMEX_PAGE, AFIMEX_RESULTS, isAfimexBlocked, normalizeAfimexNumber, parseAfimex, PROVIDER, readAfimexToken,
} from './parser.js';

export { AFIMEX_PAGE, AFIMEX_RESULTS, normalizeAfimexNumber, parseAfimex } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// Laravel's cookies: the session the form token belongs to, and its copy of the token.
const SESSION_COOKIES = /^(?:afimex_session|XSRF-TOKEN)=[^\s;,]{1,1024}/;
const DEFAULT_BUDGET_MS = 20_000;

/**
 * The same failure without the request and response details fetchBounded attaches: they hold
 * the session cookie and the form token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

/** A refusal page, told apart from a bot check. */
function refused(status: number, body: string, what: string): never {
  if (isAfimexBlocked(body)) throw new ChallengeError(PROVIDER, 'Afimex answered with a browser check', { status });
  if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
  throw new ChallengeError(PROVIDER, `Afimex refused its ${what}`, { status });
}

export class AfimexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The tracking page's form, as a visitor sends it: the page opens a session, then the guide is posted with its token. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const request = (url: string, init: RequestInit) => fetchBounded(url, { ...init, signal, headers: {
      'User-Agent': userAgentOf(this.options.userAgent), 'Accept-Language': 'es-MX,es;q=0.9',
      Accept: 'text/html,application/xhtml+xml', ...init.headers as Record<string, string> } },
    { provider: PROVIDER, timeoutMs: left(), maxBytes: AFIMEX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 419, 503] });
    try {
      const page = await request(AFIMEX_PAGE, { method: 'GET' });
      const html = decodeText(page.bytes);
      if (page.response.status === 403 || page.response.status === 503) refused(page.response.status, html, 'tracking page');
      if (page.response.status !== 200) throw new TransportError(PROVIDER, 'Afimex\'s tracking page is unavailable', { status: page.response.status });
      const token = readAfimexToken(html);
      const cookies = page.response.headers.getSetCookie().map((cookie) => SESSION_COOKIES.exec(cookie)?.[0]).filter(Boolean);
      if (!cookies.some((cookie) => cookie!.startsWith('afimex_session='))) {
        throw new IndeterminateError(PROVIDER, 'Afimex did not open a tracking session', { reason: 'session_rejected' });
      }
      signal.throwIfAborted();
      const results = await request(AFIMEX_RESULTS, { method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.join('; '), Origin: 'https://afimex.net', Referer: AFIMEX_PAGE,
      }, body: new URLSearchParams({ _token: token, guias: number }).toString() });
      const body = decodeText(results.bytes);
      const { status } = results.response;
      // Laravel's "Page Expired": the token did not match the session.
      if (status === 419) throw new IndeterminateError(PROVIDER, 'Afimex did not accept the tracking session', { reason: 'session_rejected' });
      if (status === 403 || status === 503) refused(status, body, 'tracking lookup');
      // The page answers every guide with HTTP 200; a redirect or a missing route is a moved tracker.
      if (status !== 200) throw new TransportError(PROVIDER, 'Afimex tracking is unavailable', { status });
      return parseAfimex(body, number);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAfimexNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a page is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: eight bare digits are a shape many carriers share and no detection rule offers
// Afimex, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new AfimexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
