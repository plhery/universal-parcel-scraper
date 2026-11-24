import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { readMendrixTrackingUrl, type MendrixTrackingLink } from '../../core/catalog/urls.js';
import {
  ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, MaintenanceError, NotFoundError, SchemaError, TransportError,
  UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  isMendrixBlocked, MENDRIX_API, MENDRIX_MAX_BYTES, MENDRIX_SESSION_COOKIE, mendrixJson, mendrixRefusal, mendrixSessionOrder,
  normalizeMaxPakketCode, parseMaxPakket, PROVIDER,
} from './parser.js';

export { normalizeMaxPakketCode, parseMaxPakket } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** An HTTP or network failure without the request it failed on, whose address holds the link's order. */
function withoutCapability(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, new Error('MAX Pakket tracking request failed'));
  return error;
}

/** The session cookie a reply sets, or null. */
function sessionCookie(headers: Headers): string | null {
  const prefix = `${MENDRIX_SESSION_COOKIE}=`;
  const header = headers.getSetCookie().find((value) => value.startsWith(prefix));
  const value = header?.slice(prefix.length).split(';', 1)[0]?.trim();
  return value || null;
}

export class MaxPakketTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  /** One API read: its JSON, its session cookie, or the reason the API gave none. */
  private async get(path: string, cookie: string | null, link: MendrixTrackingLink, signal: AbortSignal, deadline: number) {
    let fetched;
    try {
      fetched = await fetchBounded(`${MENDRIX_API}${path}`, { signal, headers: {
        Accept: 'application/json, text/plain, */*', Referer: link.url, 'User-Agent': userAgentOf(this.environment.userAgent),
        ...(cookie ? { Cookie: `${MENDRIX_SESSION_COOKIE}=${cookie}` } : {}),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: MENDRIX_MAX_BYTES,
        fetcher: this.environment.fetcher, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 503] });
    } catch (error) { throw withoutCapability(error); }
    const { response, bytes } = fetched;
    const { status } = response;
    const body = decodeText(bytes);
    // The API sends its replies as JSON, its refusals with a plain text type.
    const looksJson = /^\s*[{[]/.test(body);
    if (REDIRECTS.includes(status)) throw new TransportError(PROVIDER, 'MAX Pakket tracking is unavailable', { status });
    if (!looksJson && isMendrixBlocked(body)) throw new ChallengeError(PROVIDER, 'MAX Pakket answered with a browser check', { status });
    if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
    if (status !== 200) {
      // The API refuses a link it holds no order under with its own reply; only that is not found.
      if (looksJson) mendrixRefusal(mendrixJson(body));
      if (status === 404) throw new TransportError(PROVIDER, 'MAX Pakket tracking is unavailable', { status });
      if (status === 400) throw new IndeterminateError(PROVIDER, 'MAX Pakket did not complete the lookup', { status });
      throw new ChallengeError(PROVIDER, 'MAX Pakket refused the lookup', { status });
    }
    const payload = mendrixJson(body);
    if (isRecord(payload) && payload.type === 'TEoTrackAndTrace_Error_Response') mendrixRefusal(payload);
    return { payload, cookie: sessionCookie(response.headers) };
  }

  /**
   * The tracking app's reads: the address lookup with the link's code and order number opens a
   * session for that order, whose cookie names them; the milestones and scans are read in it.
   */
  private async read(link: MendrixTrackingLink, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const query = `?Tracecode=${encodeURIComponent(link.code)}&Orderid=${encodeURIComponent(link.orderId)}`;
    const opened = await this.get(`/address${query}`, null, link, signal, deadline);
    if (!isRecord(opened.payload) || opened.payload.type !== 'TEoTrackAndTrace_Address_Response' || !isRecord(opened.payload.Address)) {
      throw new SchemaError(PROVIDER, 'MAX Pakket returned an unexpected order lookup');
    }
    const order = opened.cookie ? mendrixSessionOrder(opened.cookie) : null;
    if (!order) throw new IndeterminateError(PROVIDER, 'MAX Pakket did not open a session for the order', { reason: 'session_rejected' });
    if (order.code !== link.code || order.orderId !== link.orderId) {
      throw new IndeterminateError(PROVIDER, 'MAX Pakket opened another order than the tracking link names');
    }
    try {
      const [milestones, traces] = await Promise.all([
        this.get('/milestones', opened.cookie, link, signal, deadline),
        this.get('/traces', opened.cookie, link, signal, deadline),
      ]);
      return parseMaxPakket(milestones.payload, traces.payload, link.code);
    } catch (error) {
      // The order was found: a refusal within its session is not an answer about it.
      if (error instanceof NotFoundError) throw new IndeterminateError(PROVIDER, 'MAX Pakket refused the order it had opened', { reason: 'session_rejected' });
      throw error;
    }
  }

  fetch(raw: string, trackingUrl: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const code = normalizeMaxPakketCode(raw);
    let link: MendrixTrackingLink;
    try { link = readMendrixTrackingUrl(trackingUrl, code, PROVIDER); } catch (error) {
      throw new InvalidInputError(PROVIDER, error instanceof Error ? error.message : 'The MAX Pakket tracking link is invalid');
    }
    // A read that fails to reach the API, or hangs, is sent once more: the first try gets half of
    // the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.environment.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(link, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(link, signal, remainingMs)),
    ]);
  }
}

// No recognition: the Track & Trace code is every Mendrix tenant's, so no detection rule offers
// MAX Pakket for it, and it opens an order only with the order number its link carries.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new MaxPakketTracker(environment);
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => {
      if (!input.trackingUrl) throw new InputRequiredError(PROVIDER, 'trackingUrl', 'MAX Pakket requires the track and trace link from its email');
      return tracker.fetch(input.number, input.trackingUrl, context);
    },
  };
};
