import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeEvriUkNumber, parseEvriUk } from './parser.js';

export const EVRI_UK_MOBILE_API = 'https://tracking.platform-apis.evri.com/v1';
/** The history service answered and confirmed no domestic parcel activity; the page asks the same service. */
export const EVRI_UK_UNCONFIRMED = 'parcel_unconfirmed';
const MAX_BYTES = 2_000_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
const APPLICATION_KEY = 'NpxtibhIgliySB4JRfjAQq2vytmiWGUQ';

function unconfirmed(): never {
  throw new IndeterminateError('Evri UK', 'Evri UK could not confirm a domestic parcel', { reason: EVRI_UK_UNCONFIRMED });
}

export async function readEvriUkMobile(raw: string, options: {
  key?: string | null; fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const number = normalizeEvriUkNumber(raw);
  const key = options.key === undefined ? APPLICATION_KEY : options.key?.trim();
  if (!key || !/^[\w.~+/=-]{8,512}$/.test(key)) throw new ChallengeError('Evri UK', 'Evri UK tracking API key is unavailable');
  const deadline = performance.now() + options.timeoutMs;
  const read = async (url: URL): Promise<{ status: number; payload: unknown }> => {
    const { response, bytes } = await fetchBounded(url, { signal: options.signal,
      headers: { Accept: 'application/json', apiKey: key, 'User-Agent': userAgentOf(options.userAgent) } }, {
      provider: 'Evri UK', maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
      fetcher: options.fetcher, allowHttpStatuses: [400, 401, 403, 404, 410],
    });
    if ([401, 403].includes(response.status)) throw new ChallengeError('Evri UK', 'Evri UK refused the tracking API key');
    let payload: unknown;
    try { payload = JSON.parse(decodeText(bytes)); } catch { payload = undefined; }
    // The service reports a reference it rejects as JSON; a bare status is the endpoint's.
    if (response.status !== 200 && !(isRecord(payload) && Array.isArray(payload.errors) && payload.errors.length)) {
      if ([404, 410].includes(response.status)) throw new TransportError('Evri UK', 'Evri UK tracking API is unavailable', { status: response.status });
      throw new UpstreamHttpError('Evri UK', response.status);
    }
    if (response.status === 200 && payload === undefined) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking data');
    return { status: response.status, payload };
  };
  try {
    const reference = await read(new URL(`${EVRI_UK_MOBILE_API}/parcels/reference/${number}`));
    if (reference.status !== 200) unconfirmed();
    const identifiers = isRecord(reference.payload) ? reference.payload.parcelIdentifiers : undefined;
    if (!Array.isArray(identifiers) || identifiers.length > 50) throw new SchemaError('Evri UK', 'Evri UK returned invalid parcel identifiers');
    // Several parcels or an international redirect do not settle one domestic parcel.
    const identifier: unknown = identifiers.length === 1 ? identifiers[0] : undefined;
    if (identifiers.length !== 1 || (isRecord(identifier) && identifier.redirectUrl)) unconfirmed();
    const urn = isRecord(identifier) ? identifier.urn : undefined;
    if (typeof urn !== 'string' || !new RegExp(`^urn:parcel_id:barcode:date:\\d{1,30}:${number}:\\d{4}-\\d{2}-\\d{2}$`).test(urn)) {
      throw new SchemaError('Evri UK', 'Evri UK did not return the requested parcel');
    }
    const endpoint = new URL(`${EVRI_UK_MOBILE_API}/parcels/`);
    endpoint.searchParams.set('uniqueIds', urn);
    const history = await read(endpoint);
    if (history.status !== 200) unconfirmed();
    try { return parseEvriUk(history.payload, number, urn); }
    catch (error) { if (error instanceof IndeterminateError) unconfirmed(); throw error; }
  } catch (error) {
    options.signal.throwIfAborted();
    // Transport diagnostics include the key, the barcode and recipient fields.
    // Preserve the failure contract without forwarding request or body data.
    if (error instanceof CarrierError) throw new CarrierError(error.kind, 'Evri UK', `Evri UK tracking failed (${error.kind})`, {
      status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
    });
    throw new TransportError('Evri UK', 'Evri UK tracking API request failed');
  }
}
