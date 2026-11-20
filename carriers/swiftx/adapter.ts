import type { AdapterFactory, TrackingContext, TrackingInput } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { normalizeSwiftxNumber, parseSwiftx, PROVIDER, SWIFTX_API, SWIFTX_MAX_BYTES, swiftxPhoneDigits, swiftxTrackingUrl } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export { normalizeSwiftxNumber, parseSwiftx, swiftxPhoneDigits, swiftxTrackingUrl, swiftxWording } from './parser.js';

/** What the browser service may spend on one lookup; the page's checks take a few seconds when they pass. */
const SERVICE_MS = 30_000;
const SETTLE_MS = 10_000;
/** The service's capture helper ends a page that never asked for the number with this reason. */
const NO_QUERY = `${PROVIDER} produced no tracking response after submission`;

/**
 * Whether the browser service's HTTP 500 says its last browser tier stood at
 * a check it could not pass: a challenge wall, or a page that never sent its
 * query because its Turnstile widget or puzzle was not passed. The tiers ran
 * out, or the deadline did while the next tier was still trying. Any other
 * failure keeps its own kind.
 */
function trawlChallenged(error: unknown): boolean {
  if (!(error instanceof UpstreamHttpError) || error.status !== 500) return false;
  let reply: unknown;
  try { reply = JSON.parse(error.diagnostics?.body_excerpt ?? ''); } catch { return false; }
  if (!isRecord(reply) || !Array.isArray(reply.timings)
    || (reply.error !== 'Max tier reached without success' && reply.error !== 'Scrape deadline exceeded')) return false;
  const last: unknown = reply.timings.at(-1);
  return isRecord(last) && (last.tier === 2 || last.tier === 3)
    && (last.status === 'blocked' || (last.status === 'error' && last.reason === NO_QUERY));
}

/**
 * The tracking reply the page's own request received. The capture helper keeps
 * only the page's query for the whole number; the newest reply is final. Given
 * the recipient's phone digits, the newest reply to the query that carried
 * them is final, and the page's first reply when it never sent them.
 */
export function parseSwiftxCapture(page: TrawlScrapeResponse, number: string, readAt = Date.now(), phoneDigits = false): CarrierResult {
  const rows = page.capturedResponses.filter((row) => row.url === SWIFTX_API);
  const unlocked = phoneDigits ? rows.filter((row) => row.phoneDigitsSubmitted === true).at(-1) : undefined;
  const reply = unlocked ?? rows.at(-1);
  if (!reply || rows.length > 10) throw new ChallengeError(PROVIDER, 'SwiftX returned no tracking reply in the browser');
  if (reply.status === 429) {
    throw new RateLimitedError(PROVIDER, retryAfterMs(reply.headers['retry-after'], { dates: false, maxDigits: 5 }));
  }
  if (reply.status === 401 || reply.status === 403) throw new ChallengeError(PROVIDER, 'SwiftX refused the browser tracking request', { status: reply.status });
  if (reply.status >= 400) throw new UpstreamHttpError(PROVIDER, reply.status);
  if (reply.status !== 200 || reply.error || reply.truncated || reply.base64Encoded || reply.body === null) {
    throw new TransportError(PROVIDER, 'SwiftX returned an incomplete browser response');
  }
  if (reply.body.length > SWIFTX_MAX_BYTES) throw new SchemaError(PROVIDER, 'SwiftX returned excessive tracking data');
  // A page in place of the reply is the edge's challenge, not a missing parcel.
  if (/^\s*</.test(reply.body)) throw new ChallengeError(PROVIDER, 'SwiftX returned a browser challenge');
  let payload: unknown;
  try { payload = JSON.parse(reply.body); } catch (error) { throw new SchemaError(PROVIDER, 'SwiftX returned unreadable tracking JSON', { cause: error }); }
  return parseSwiftx(payload, number, readAt, phoneDigits ? unlocked ? 'submitted' : 'unsent' : undefined);
}

/**
 * One lookup through the browser service: the tracking page passes
 * Cloudflare's check, asks its GraphQL endpoint for the number and the
 * service's capture helper returns that reply. The recipient's phone digits
 * travel in the address's fragment, which the browser never sends; the
 * service's helper types them into the page's own field.
 */
export async function swiftxBrowser(trawl: TrawlClient, raw: string, signal: AbortSignal, remainingMs: number,
  fetcher?: typeof fetch, phoneDigits?: string): Promise<CarrierResult> {
  const number = normalizeSwiftxNumber(raw);
  const digits = swiftxPhoneDigits(phoneDigits);
  const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - 2000));
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  let page: TrawlScrapeResponse;
  try {
    page = await trawl.scrape({ url: `${swiftxTrackingUrl(number)}${digits ? `#trawl-phone-digits=${digits}` : ''}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [SWIFTX_API], settleTimeout: SETTLE_MS },
    { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, signal, fetcher, maxBytes: 4 * SWIFTX_MAX_BYTES });
  } catch (error) {
    if (trawlChallenged(error)) throw new ChallengeError(PROVIDER, 'SwiftX\'s tracking page did not pass its verification in the browser', { cause: error });
    throw error;
  }
  signal.throwIfAborted();
  return parseSwiftxCapture(page, number, Date.now(), Boolean(digits));
}

export class SwiftxTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}, phoneDigits?: TrackingInput['phoneDigits']): Promise<CarrierResult> {
    const number = normalizeSwiftxNumber(raw);
    const digits = swiftxPhoneDigits(phoneDigits);
    const trawl = this.options.trawl;
    // Cloudflare challenges the tracker and its API for other clients, and the query needs the page's verification.
    if (!trawl) throw new ChallengeError(PROVIDER, 'SwiftX requires the browser tracking service');
    return runSteps({ carrier: 'swiftx', budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => swiftxBrowser(trawl, number, signal, remainingMs, this.options.fetcher, digits) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SwiftxTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'swiftx', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context, input.phoneDigits) };
};
