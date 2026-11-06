import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { EVRI_UK_UNCONFIRMED } from './mobile.js';
import { evriUkTrackingUrl, parseEvriUk } from './parser.js';

const SEARCH = 'https://api.evri.com/customer-tracking/v1/search/';
const HISTORY = 'https://tracking.platform-apis.evri.com/v1/parcels';

function unconfirmed(): IndeterminateError {
  return new IndeterminateError('Evri UK', 'Evri UK could not confirm a domestic parcel', { reason: EVRI_UK_UNCONFIRMED });
}

function httpFailure(status: number, retryAfter?: string): Error {
  if (status < 100) return new TransportError('Evri UK', 'Evri UK browser request failed');
  if ([401, 403, 405].includes(status)) return new ChallengeError('Evri UK');
  if ([404, 410].includes(status)) return new TransportError('Evri UK', 'Evri UK tracking endpoint is unavailable', { status });
  const wait = retryAfter === undefined ? NaN : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  return new UpstreamHttpError('Evri UK', status, Number.isFinite(wait) ? Math.max(0, wait) : undefined);
}

function searchIdentity(payload: unknown, number: string): string {
  if (!isRecord(payload) || !Array.isArray(payload.parcels) || payload.parcels.length > 50) {
    throw new SchemaError('Evri UK', 'Evri UK returned invalid parcel search data');
  }
  if (payload.parcels.length !== 1) throw unconfirmed();
  const parcel: unknown = payload.parcels[0];
  if (!isRecord(parcel) || !isRecord(parcel.brand) || typeof parcel.brand.name !== 'string'
    || !Array.isArray(parcel.identifiers) || parcel.identifiers.length > 50
    || !parcel.identifiers.every(id => isRecord(id) && typeof id.type === 'string' && typeof id.value === 'string')) {
    throw new SchemaError('Evri UK', 'Evri UK returned invalid parcel identifiers');
  }
  if (parcel.brand.name !== 'EVRI' || parcel.externalRedirectUrl) throw unconfirmed();
  const ids = parcel.identifiers.filter(id => isRecord(id) && id.type === 'PARCEL_ID');
  const barcodes = parcel.identifiers.filter(id => isRecord(id) && id.type === 'BARCODE');
  if (ids.length !== 1 || barcodes.length !== 1 || !isRecord(ids[0]) || !isRecord(barcodes[0])
    || typeof ids[0].value !== 'string' || !/^\d{1,30}$/.test(ids[0].value) || barcodes[0].value !== number) {
    throw new SchemaError('Evri UK', 'Evri UK did not return the whole requested barcode');
  }
  return ids[0].value;
}

/** The guest search and history stay bound across the page's own verification and retries. */
export async function readEvriUkTrawl(number: string, trawl: TrawlClient, options: {
  fetcher?: typeof fetch; signal: AbortSignal; remainingMs: number;
}): Promise<CarrierResult> {
  const timeoutMs = Math.floor(Math.min(25_000, options.remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
  if (timeoutMs < 1) throw new BudgetExceededError('Evri UK', options.remainingMs);
  const url = evriUkTrackingUrl(number);
  const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
    captureResponses: [SEARCH + number, HISTORY], settleTimeout: 1000 },
  { provider: 'TRAWL while fetching Evri UK', timeoutMs, signal: options.signal, fetcher: options.fetcher,
    maxBytes: 6_000_000, requireSolved: false, captureWindow: 'last' });
  options.signal.throwIfAborted();
  if (page.url !== url || (typeof page.raw.effectiveUrl === 'string' && page.raw.effectiveUrl !== url)) {
    throw new SchemaError('Evri UK', 'Evri UK redirected away from its tracking page');
  }
  let parcelId: string | undefined;
  let result: CarrierResult | undefined;
  let failure: Error | undefined;
  for (const entry of page.capturedResponses) {
    let endpoint: URL;
    try { endpoint = new URL(entry.url); } catch { continue; }
    const search = entry.url === SEARCH + number;
    if (!search && endpoint.origin === 'https://api.evri.com' && endpoint.pathname.startsWith('/customer-tracking/v1/search/')) {
      throw new SchemaError('Evri UK', 'Evri UK search request did not name the whole barcode');
    }
    const history = endpoint.origin === 'https://tracking.platform-apis.evri.com' && /^\/v1\/parcels\/?$/.test(endpoint.pathname);
    if (!search && !history) continue;
    if (!entry.trackingNumberSubmitted) throw new TransportError('Evri UK', 'The browser service does not support bound Evri UK capture');
    if (entry.trackingNumberSubmitted !== number) throw new SchemaError('Evri UK', 'The browser service did not bind the whole barcode');
    result = undefined;
    if (search) parcelId = undefined;
    if (entry.status !== 200) { failure = httpFailure(entry.status, entry.headers['retry-after']); continue; }
    if (entry.headers['x-amzn-waf-action'] || entry.error === 'verification-required') { failure = new ChallengeError('Evri UK'); continue; }
    if (entry.truncated || entry.error || entry.base64Encoded || typeof entry.body !== 'string'
      || new TextEncoder().encode(entry.body).byteLength > (search ? 200_000 : 2_000_000)) {
      throw new SchemaError('Evri UK', 'Evri UK returned unreadable tracking data');
    }
    let payload: unknown;
    try { payload = JSON.parse(entry.body); }
    catch { throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking JSON'); }
    try {
      if (search) {
        parcelId = searchIdentity(payload, number); failure = undefined; continue;
      }
      if (!parcelId) throw new TransportError('Evri UK', 'Evri UK history has no bound parcel search');
      const urn = endpoint.searchParams.get('uniqueIds');
      if (endpoint.username || endpoint.password || endpoint.hash || [...endpoint.searchParams].length !== 1
        || endpoint.searchParams.getAll('uniqueIds').length !== 1 || typeof urn !== 'string'
        || !new RegExp('^urn:parcel_id:barcode:date:' + parcelId + ':' + number + ':\\d{4}-\\d{2}-\\d{2}$').test(urn)) {
        throw new SchemaError('Evri UK', 'Evri UK history request did not match the parcel search');
      }
      result = parseEvriUk(payload, number, urn); failure = undefined;
    } catch (error) {
      if (error instanceof SchemaError) throw error;
      failure = error instanceof IndeterminateError ? unconfirmed()
        : error instanceof Error ? error : new TransportError('Evri UK', 'Evri UK tracking could not be read');
    }
  }
  if (result) return result;
  if (failure) throw failure;
  if (page.statusCode !== 200) throw httpFailure(page.statusCode);
  throw new TransportError('Evri UK', 'Evri UK page sent no bound tracking response');
}
