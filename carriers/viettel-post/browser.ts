import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { isRecord } from '../../core/types.js';
import { parseViettelPostHistory } from './history.js';
import { normalizeViettelPostNumber, PROVIDER, VIETTEL_MAX_BYTES } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export const VIETTEL_POST_HISTORY_API = 'https://api.viettelpost.vn/api/orders/viewTrackingOrders3';
export function viettelPostHistoryUrl(raw: string): string {
  return 'https://viettelpost.vn/viettelpost-iframe/tra-cuu-hanh-trinh-don-hang-v3-recaptcha?'
    + new URLSearchParams({ orders: normalizeViettelPostNumber(raw) }).toString();
}

function retryAfter(headers: Record<string, string>): number | undefined {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  return retryAfterMs(value);
}

export async function fetchViettelPostHistory(number: string, options: { trawl: TrawlClient; fetcher?: typeof fetch;
  proxy?: string; signal: AbortSignal; remainingMs: number; legacyReserveMs: number }): Promise<CarrierResult> {
  const timeoutMs = Math.floor(Math.min(60_000, options.remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS - options.legacyReserveMs));
  if (timeoutMs < 1000) throw new BudgetExceededError(PROVIDER, options.remainingMs);
  const url = viettelPostHistoryUrl(number);
  const page = await trawlPrivateScrape(options.trawl, { url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
    captureResponses: [VIETTEL_POST_HISTORY_API], settleTimeout: timeoutMs, ...(options.proxy ? { proxy: options.proxy } : {}) },
  { provider: PROVIDER, timeoutMs, signal: options.signal, fetcher: options.fetcher,
    maxBytes: 4 * VIETTEL_MAX_BYTES, requireSolved: false, captureWindow: 'last' });
  options.signal.throwIfAborted();
  if (![2, 3].includes(page.tier)) throw new TransportError(PROVIDER, 'Viettel Post did not return a browser capture');
  if (page.url !== url) throw new SchemaError(PROVIDER, 'Viettel Post left the requested guest lookup');
  const rows = page.capturedResponses.filter(row => row.url === VIETTEL_POST_HISTORY_API);
  if (rows.length > 2) throw new SchemaError(PROVIDER, 'Viettel Post returned too many history replies');
  let result: CarrierResult | undefined, failure: Error | undefined;
  for (const row of rows) {
    result = undefined;
    if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'Viettel Post did not bind the whole history request');
    if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter(row.headers));
    if ([400, 401, 403, 428].includes(row.status) || row.error === 'challenge-html') {
      failure = new ChallengeError(PROVIDER, 'Viettel Post refused guest history verification', { status: row.status }); continue;
    }
    if (row.status === 0 || [404, 410].includes(row.status)) {
      failure = new TransportError(PROVIDER, 'Viettel Post guest history is unavailable', { status: row.status }); continue;
    }
    if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status);
    if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Viettel Post returned invalid history JSON');
    if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
      || new TextEncoder().encode(row.body).byteLength > VIETTEL_MAX_BYTES) {
      failure = new TransportError(PROVIDER, 'Viettel Post returned incomplete guest history'); continue;
    }
    let payload: unknown; try { payload = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Viettel Post returned invalid history JSON'); }
    try { result = parseViettelPostHistory(payload, number); failure = undefined; }
    catch (error) {
      if (error instanceof RateLimitedError) throw new RateLimitedError(PROVIDER, retryAfter(row.headers));
      if (error instanceof SchemaError) throw error;
      if (!(error instanceof Error)) throw new SchemaError(PROVIDER);
      failure = error;
    }
  }
  if (result) return result;
  if (failure) throw failure;
  if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
  if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Viettel Post refused the guest history page', { status: page.statusCode });
  if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
  const last: unknown = Array.isArray(page.raw?.timings) ? page.raw.timings.at(-1) : undefined;
  if (page.statusCode === 0 || isRecord(last) && ['viettel-post-runtime', 'viettel-post-capture_missing'].includes(String(last.reason))) {
    const missing = page.statusCode !== 0 && isRecord(last) && last.reason === 'viettel-post-capture_missing';
    throw new TransportError(PROVIDER, 'Viettel Post could not initialize or capture its guest lookup', missing ? { reason: 'capture_missing' } : undefined);
  }
  throw new ChallengeError(PROVIDER, 'Viettel Post did not finish guest history verification', { reason: 'verification_unfinished' });
}
