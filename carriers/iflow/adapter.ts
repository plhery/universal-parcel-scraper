import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { IFLOW_MAX_BYTES, isIflowServerError, normalizeIflowNumber, parseIflowOrderReply, parseIflowSearch, PROVIDER } from './parser.js';

export { normalizeIflowNumber, parseIflowOrder, parseIflowSearch, withoutPeople } from './parser.js';

/** The API that iFLOW's tracker on tracking.iflow21.com asks from the browser. */
export const IFLOW_API = 'https://api-btp.iflow21.com';
/** The tracker page that asks it. */
const IFLOW_PAGE = 'https://tracking.iflow21.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The search that turns a code into the tracker's internal id. */
export const iflowSearchUrl = (code: string): string => `${IFLOW_API}/tracking/order/search/${encodeURIComponent(code)}`;
/** The order behind an internal id. */
export const iflowOrderUrl = (trackingId: string): string => `${IFLOW_API}/tracking/order/${encodeURIComponent(trackingId)}`;

export class IflowTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One GET within the attempt's deadline: its status and body, or the failure of a moved route. */
  private async get(url: string, signal: AbortSignal, deadline: number): Promise<{ status: number; body: string }> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      // What the tracker's page sends from the browser; the API asks for no cookie or token.
      Accept: 'application/json, text/plain, */*', Origin: IFLOW_PAGE, Referer: `${IFLOW_PAGE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: IFLOW_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 500] })
      // A request the caller cancelled ends with the caller's reason.
      .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
    signal.throwIfAborted();
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'iFLOW tracking API moved', { status: response.status });
    }
    return { status: response.status, body: decodeText(bytes) };
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // Both requests share the attempt's time: the order is asked with what the search left.
    const deadline = performance.now() + timeoutMs;
    const search = await this.get(iflowSearchUrl(number), signal, deadline);
    if (search.status === 500) {
      // The search's answer for a code it holds no record of, a number aged out of it included, and for a failed lookup.
      if (isIflowServerError(search.body)) {
        throw new IndeterminateError(PROVIDER, 'iFLOW holds no record of this code or failed to look it up', { reason: 'portal_not_found', status: 500 });
      }
      throw new TransportError(PROVIDER, 'iFLOW tracking API failed', { status: 500 });
    }
    const trackingId = parseIflowSearch(search.body, number);
    const order = await this.get(iflowOrderUrl(trackingId), signal, deadline);
    // The search has just found the code, so a failed order read says nothing about it.
    if (order.status === 500) throw new IndeterminateError(PROVIDER, 'iFLOW found the code but failed to read its order', { status: 500 });
    return parseIflowOrderReply(order.body, number, trackingId);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeIflowNumber(raw);
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IflowTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The search's server error is its answer for a code it holds no record of: recognition reads it as unknown.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeIflowNumber(number))),
  };
};
