import { BudgetExceededError, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { budgetWhenOutOfTime, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlCapturedResponse, type TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { isDpdUkReferenceAbsent, parseDpdUkHistory, parseDpdUkReference, PROVIDER, validateDpdUkParcel } from './parser.js';

const API_ORIGIN = 'https://apis.track.dpd.co.uk';
/** The API root the browser service captures under; its helper binds each read to the number. */
export const DPD_UK_BROWSER_API = `${API_ORIGIN}/v1/`;
/** The browser read needs this long after its transport allowance to open the page and read three replies. */
export const DPD_UK_BROWSER_MIN_MS = 10_000;
const DPD_UK_BROWSER_MAX_MS = 25_000;
const MAX_BODY_BYTES = 1_000_000;

export type DpdUkStage = 'reference search' | 'parcel detail' | 'parcel events';

export function dpdUkTrackingUrl(number: string): string {
  return `https://track.dpd.co.uk/?reference=${number}`;
}

/**
 * DPD UK's refusal, naming the read it stopped and DPD UK's own notice, or an HTML page in its
 * place. A notice with digits or other characters is left out: it could carry a handle.
 */
export function dpdUkRefusal(stage: DpdUkStage, status: number, body: string): ChallengeError {
  const text = body.slice(0, 4096);
  let notice = /^\s*</.test(text) ? 'an HTML page' : '';
  try {
    const payload: unknown = JSON.parse(text);
    const message = isRecord(payload) && isRecord(payload.error) ? payload.error.message : undefined;
    if (typeof message === 'string' && message.length <= 160 && /^[A-Za-z][A-Za-z ,.'’!-]*$/.test(message)) notice = `"${message}"`;
  } catch { /* Not DPD UK's JSON envelope. */ }
  return new ChallengeError(PROVIDER, `${PROVIDER} refused the ${stage} with HTTP ${status}${notice ? `: ${notice}` : ''}`,
    { status, reason: 'api_denied' });
}

function stageOf(raw: string, number: string, code: string | undefined): DpdUkStage | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) return null;
  if (url.pathname === '/v1/reference') {
    return url.searchParams.getAll('referenceNumber').length === 1 && url.searchParams.get('referenceNumber') === number ? 'reference search' : null;
  }
  if (code === undefined) return null;
  const parcel = `/v1/parcels/${encodeURIComponent(code)}`;
  if (url.pathname === parcel) return 'parcel detail';
  return url.pathname === `${parcel}/parcelevents` ? 'parcel events' : null;
}

/** The JSON of one bound read, or the failure its status and completeness say. */
function payloadOf(entry: TrawlCapturedResponse | undefined, stage: DpdUkStage): unknown {
  if (!entry) throw new TransportError(PROVIDER, `${PROVIDER} page did not return the ${stage}`, { reason: 'capture_missing' });
  if (entry.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(entry.headers['retry-after']));
  if (entry.status === 401 || entry.status === 403) throw dpdUkRefusal(stage, entry.status, entry.body ?? '');
  if (entry.status === 404 || entry.status === 410) {
    let payload: unknown;
    try { payload = entry.body === null ? null : JSON.parse(entry.body); } catch { /* Not the named absence. */ }
    if (entry.status === 404 && stage === 'reference search' && isDpdUkReferenceAbsent(payload)) throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'DPD UK tracking endpoint is unavailable', { status: entry.status });
  }
  if (entry.status < 100) throw new TransportError(PROVIDER, `${PROVIDER} browser ${stage} failed`);
  if (entry.status !== 200) throw new UpstreamHttpError(PROVIDER, entry.status, retryAfterMs(entry.headers['retry-after']));
  if (entry.error || entry.truncated || entry.base64Encoded || entry.body === null
    || new TextEncoder().encode(entry.body).byteLength > MAX_BODY_BYTES) {
    throw new TransportError(PROVIDER, `${PROVIDER} returned an incomplete browser ${stage}`);
  }
  let payload: unknown;
  try { payload = JSON.parse(entry.body); } catch { throw new SchemaError(PROVIDER); }
  return payload;
}

/**
 * The public tracker's own reads in the browser service: its reference search for the whole
 * number, then the detail and events under the code that search issued, checked as over HTTP.
 */
export async function readDpdUkTrawl(number: string, trawl: TrawlClient, options: {
  fetcher?: typeof fetch; signal: AbortSignal; remainingMs: number;
}): Promise<CarrierResult> {
  const timeoutMs = Math.floor(Math.min(DPD_UK_BROWSER_MAX_MS, options.remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, options.remainingMs);
  const page = await trawl.scrape({ url: dpdUkTrackingUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
    captureResponses: [DPD_UK_BROWSER_API], settleTimeout: 1000 },
  { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, signal: options.signal, fetcher: options.fetcher,
    maxBytes: 6_000_000, requireSolved: false, captureWindow: 'last' })
    .catch(budgetWhenOutOfTime(PROVIDER, options.remainingMs));
  options.signal.throwIfAborted();
  const entries = page.capturedResponses.filter(entry => entry.url.startsWith(DPD_UK_BROWSER_API));
  if (entries.some(entry => entry.trackingNumberSubmitted === undefined)) {
    throw new TransportError(PROVIDER, 'The browser service does not support bound DPD UK capture');
  }
  if (entries.some(entry => entry.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'The browser service did not bind the whole number');
  const last = (stage: DpdUkStage, code?: string) => entries.filter(entry => stageOf(entry.url, number, code) === stage).at(-1);
  const code = parseDpdUkReference(payloadOf(last('reference search'), 'reference search'), number);
  const detail = payloadOf(last('parcel detail', code), 'parcel detail');
  validateDpdUkParcel(detail, number, code);
  return parseDpdUkHistory(detail, payloadOf(last('parcel events', code), 'parcel events'), number, code);
}
