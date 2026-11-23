import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  MARFRET_MAX_BYTES, MARFRET_ORIGIN, MARFRET_TRACKER, MAX_PAGES, marfretPage, marfretPageForm, marfretQuery, marfretResult, marfretSearch,
  marfretSearchForm, marfretViewState, PROVIDER, type MarfretRow, type MarfretSearch,
} from './parser.js';

export { containerCheckDigit, marfretQuery, marfretResult, marfretSearch, marfretSearchForm } from './parser.js';

const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;
// A later page is asked only while this much of the attempt is left.
const PAGE_RESERVE_MS = 2_000;

export interface MarfretTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

/** One session of the tracker: its cookies, the time it may take and the requests it makes. */
type Session = { post: (body: URLSearchParams) => Promise<string>; get: () => Promise<string>; left: () => number };

export class MarfretTracker {
  constructor(private readonly options: MarfretTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = marfretQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Marfret budget must be positive');
    // A request that fails to reach the tracker, or hangs, gets one more session.
    return runSteps<CarrierResult>({ carrier: 'marfret', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /**
   * The tracker's page for its view and cookies, then its search for the container. A view the
   * tracker no longer holds gets one fresh session. The moves past the first page are asked
   * page by page while the attempt has time.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const jar = new CookieJar();
      try {
        const session = this.session(jar, signal, deadline, timeoutMs);
        let viewState = marfretViewState(await session.get());
        const search = marfretSearch(await session.post(marfretSearchForm(number, viewState)), number);
        if (!search) continue;
        viewState = search.viewState ?? viewState;
        const rows = [...search.rows];
        const complete = await this.pages(session, number, viewState, search, rows, signal);
        return marfretResult(rows, { listed: search.listed, truncated: !complete });
      } finally {
        await jar.removeAllCookies();
      }
    }
    throw new TransportError(PROVIDER, 'Marfret\'s tracker gave up the search\'s view twice');
  }

  /** The moves past the search's first page, added to `rows`; whether the table was read whole. */
  private async pages(session: Session, number: string, viewState: string, search: MarfretSearch, rows: MarfretRow[], signal: AbortSignal): Promise<boolean> {
    let view = viewState;
    for (let page = 1; rows.length < search.rowCount; page += 1) {
      if (page >= MAX_PAGES || session.left() < PAGE_RESERVE_MS) return false;
      try {
        const reply = marfretPage(await session.post(marfretPageForm(number, view, rows.length, search.pageRows)), number, rows.length);
        if (!reply?.rows.length) return false;
        rows.push(...reply.rows);
        view = reply.viewState ?? view;
      } catch (error) {
        // The first page stands; a later one the tracker fails leaves the history truncated.
        if (signal.aborted || !(error instanceof CarrierError)) throw error;
        return false;
      }
    }
    return true;
  }

  private session(jar: CookieJar, signal: AbortSignal, deadline: number, timeoutMs: number): Session {
    const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, jar);
    const userAgent = userAgentOf(this.options.userAgent);
    const left = () => Math.floor(deadline - performance.now());
    const request = async (init: RequestInit): Promise<string> => {
      signal.throwIfAborted();
      if (left() <= 0) throw new BudgetExceededError(PROVIDER, timeoutMs);
      let reply: Awaited<ReturnType<typeof fetchBounded>>;
      try {
        reply = await fetchBounded(MARFRET_TRACKER, { ...init, signal }, { provider: PROVIDER, timeoutMs: Math.min(REQUEST_LIMIT_MS, left()),
          maxBytes: MARFRET_MAX_BYTES, redirect: 'manual', fetcher, allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410] });
      } catch (error) {
        // The request's diagnostics would carry the session's view; the status and reply stand.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs, error.diagnostics);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, error.cause);
        throw error;
      }
      if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'Marfret\'s tracker did not answer', { status: reply.response.status });
      return decodeText(reply.bytes);
    };
    return {
      left,
      get: () => request({ method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent } }),
      post: body => request({ method: 'POST', body: body.toString(), headers: {
        Accept: 'application/xml, text/xml, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest', Origin: MARFRET_ORIGIN, Referer: MARFRET_TRACKER, 'User-Agent': userAgent,
      } }),
    };
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new MarfretTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'marfret', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
