import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { inpostUkTrackingUrl } from './number.js';

// InPost UK's own tracker, which Yodel's former tracker forwards to: its result page runs a Turnstile check and posts
// the number with the widget's token to this endpoint. The browser service's InPost UK helper lets the page do both
// and returns the one reply, reduced to the parcel's statuses, destination and scans.
export const INPOST_UK_API = 'https://inpost.co.uk/tracking/api';
const PROVIDER = 'InPost UK';
const MAX_BODY_BYTES = 256_000;
/** The longest the browser service may spend on the page, its Turnstile check and the reply. */
export const INPOST_UK_BROWSER_MS = 50_000;

/** One scan of InPost UK's reply, in the hub's code family. */
export interface InpostUkScan { code: string; wording: string; time: unknown; place: string }

/** The parcel InPost UK's tracker holds for the number, or `null` when it holds none. */
export interface InpostUkParcel {
  /** The tracker's summary status, such as DELIVERED or IN_TRANSIT_LAST_MILE. */
  status: string;
  statusTitle: string;
  statusDescription: string;
  destinationCountry?: string;
  scans: InpostUkScan[];
}

/** InPost UK's reply for one number: its parcel, or `null` when the tracker answers that it has none. */
export function parseInpostUkReply(payload: unknown, trackingNumber: string): InpostUkParcel | null {
  if (!isRecord(payload) || typeof payload.status !== 'string') throw new SchemaError(PROVIDER, 'InPost UK returned an invalid reply');
  if (payload.status === 'not_found') return null;
  if (payload.status !== 'ok') throw new TransportError(PROVIDER, 'InPost UK could not read the parcel');
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'InPost UK returned no parcel list');
  const parcel: unknown = (payload.data as unknown[]).find((entry) => isRecord(entry) && clean(entry.mainTrackingNumber, 64).toLocaleUpperCase('en-US') === trackingNumber);
  if (!isRecord(parcel)) throw new SchemaError(PROVIDER, payload.data.length ? 'InPost UK returned a different shipment' : 'InPost UK returned no parcel');
  if (parcel.events !== undefined && !Array.isArray(parcel.events)) throw new SchemaError(PROVIDER, 'InPost UK returned invalid tracking history');
  const country = isRecord(parcel.destination) ? parcel.destination.countryCode : undefined;
  return {
    status: clean(parcel.status, 40),
    statusTitle: clean(parcel.statusTitle, 500),
    statusDescription: clean(parcel.statusDescription, 500),
    ...(typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? { destinationCountry: country } : {}),
    scans: (Array.isArray(parcel.events) ? parcel.events : []).filter(isRecord).slice(0, 100).map((event) => {
      const location = isRecord(event.location) ? event.location : {};
      const city = clean(location.city, 120), countryCode = clean(location.countryCode, 2);
      return {
        code: clean(event.eventCode, 32).toLocaleUpperCase('en-US'),
        wording: clean(event.eventTitle, 500),
        time: event.timestamp,
        // The hub's form, "Exampletown (GB)", so both sources place a scan alike.
        place: city ? `${city}${/^[A-Z]{2}$/.test(countryCode) ? ` (${countryCode})` : ''}` : '',
      };
    }),
  };
}

/** Ask InPost UK's own tracker through the browser service's helper for the number. */
export async function fetchInpostUk(environment: Pick<AdapterEnvironment, 'trawl' | 'fetcher'>, trackingNumber: string, signal: AbortSignal,
  remainingMs: number): Promise<InpostUkParcel | null> {
  const url = inpostUkTrackingUrl(trackingNumber);
  if (!url || !environment.trawl) throw new ChallengeError(PROVIDER, 'InPost UK needs the browser tracking service');
  const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
  const timeoutMs = Math.floor(Math.min(INPOST_UK_BROWSER_MS, remainingMs - allowance));
  if (timeoutMs < 10_000) throw new BudgetExceededError(PROVIDER, remainingMs);
  const page = await environment.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs, captureResponses: [INPOST_UK_API],
    settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal, fetcher: environment.fetcher, requireSolved: false, captureWindow: 'last',
    maxBytes: 2 * MAX_BODY_BYTES });
  signal.throwIfAborted();
  if (page.url !== url) throw new SchemaError(PROVIDER, 'InPost UK left its tracking page');
  const rows = page.capturedResponses.filter((row) => row.url === INPOST_UK_API);
  if (rows.length > 2) throw new SchemaError(PROVIDER, 'InPost UK returned too many replies');
  const row = rows.at(-1);
  if (row) {
    if (row.trackingNumberSubmitted !== trackingNumber) throw new SchemaError(PROVIDER, 'InPost UK did not bind the whole request');
    if (row.status === 429) {
      const value = Object.entries(row.headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      throw new RateLimitedError(PROVIDER, retryAfterMs(value, { dates: false }));
    }
    // A refused token or check keeps its status alone.
    if ([401, 403].includes(row.status)) throw new ChallengeError(PROVIDER, 'InPost UK refused its tracking check', { status: row.status });
    // A known number answers 200 and an unknown one 404, each with the tracker's JSON.
    if (row.status !== 200 && row.status !== 404) throw new UpstreamHttpError(PROVIDER, row.status);
    if (row.error === 'challenge-html') throw new ChallengeError(PROVIDER, 'InPost UK answered with a challenge page');
    if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string') throw new TransportError(PROVIDER, 'InPost UK tracking capture is incomplete');
    let payload: unknown;
    try { payload = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'InPost UK returned invalid tracking JSON'); }
    // A 404 holds the tracker's own not-found answer; a 200 its parcel.
    const parcel = parseInpostUkReply(payload, trackingNumber);
    if ((parcel === null) !== (row.status === 404)) throw new SchemaError(PROVIDER, 'InPost UK\'s reply does not match its status');
    return parcel;
  }
  if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
  if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
  if (!page.statusCode) throw new TransportError(PROVIDER, 'InPost UK\'s tracking page did not load');
  // The page never posted the number: its Turnstile check did not finish.
  throw new ChallengeError(PROVIDER, 'InPost UK did not complete its Turnstile check');
}
