import { accepted, recognizeFromBrowserLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, trawlOutOfTime } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { flashCourierStage } from './status.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

const PROVIDER = 'Flash Courier';
const ORIGIN = 'https://www.flashcourier.com.br';
const PROTOCOL = 'flash-courier-guest-v1';
const SERVICE_MS = 40_000;
export function normalizeFlashCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{1,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Flash Courier requires an alphanumeric tracking or customer reference');
  return number;
}
export const flashCourierApi = (number: string): string => `${ORIGIN}/api/hawb/${number}/tipo/todos`;
function schema(message: string): never { throw new SchemaError(PROVIDER, message); }
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return schema('Flash Courier returned an invalid text field');
  return value.trim();
}
function localClock(value: unknown): string {
  const raw = text(value, 80), m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return schema('Flash Courier changed its scan clock');
  const day = calendarDay(+m[3]!, +m[2]!, +m[1]!);
  if (!day || +m[4]! > 23 || +m[5]! > 59 || +m[6]! > 59) return schema('Flash Courier returned an invalid scan clock');
  return `${day}T${m[4]}:${m[5]}:${m[6]}`;
}
/** Only the scoped guest helper's identity/status/clock projection is accepted. */
export function parseFlashCourier(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFlashCourierNumber(raw);
  if (!isRecord(payload) || typeof payload.kind !== 'string') return schema('Flash Courier returned an invalid projection');
  if (payload.kind === 'captcha_refused') throw new ChallengeError(PROVIDER, 'Flash Courier refused its image code');
  if (payload.kind === 'not_found') {
    if (payload.number !== number) return schema('Flash Courier returned another missing reference');
    throw new NotFoundError(PROVIDER);
  }
  if (payload.kind === 'empty_history') {
    if (payload.number !== number) return schema('Flash Courier returned another reference');
    throw new IndeterminateError(PROVIDER, 'Flash Courier returned no history', { reason: 'empty_history' });
  }
  if (['ambiguous', 'unconfirmed'].includes(payload.kind)) throw new IndeterminateError(PROVIDER, 'Flash Courier did not identify one shipment', { reason: payload.kind });
  if (payload.kind !== 'history' || payload.success !== true || payload.number !== number
    || typeof payload.primaryNumber !== 'string' || !/^[A-Z0-9]{1,20}$/.test(payload.primaryNumber)
    || payload.customerReference !== null && (typeof payload.customerReference !== 'string' || !/^[A-Z0-9]{1,20}$/.test(payload.customerReference))
    || payload.primaryNumber !== number && payload.customerReference !== number
    || !Array.isArray(payload.events) || !payload.events.length || payload.events.length > 500) return schema('Flash Courier returned another or invalid shipment');
  const events: CarrierEvent[] = payload.events.map(row => {
    if (!isRecord(row)) return schema('Flash Courier returned an invalid scan');
    const description = text(row.status, 500), stage = flashCourierStage(description);
    return { local_time: localClock(row.clock), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  // One domestic history uses wall clocks without offsets. Preserve their values and stable tie order.
  events.reverse();
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events[0]!, stage = flashCourierStage(newest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null, events };
}
function http(status: number, retryAfter?: unknown): never {
  if (status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(retryAfter, { dates: false, maxDigits: 6 }));
  if ([401, 403, 428].includes(status)) throw new ChallengeError(PROVIDER, 'Flash Courier refused guest tracking', { status });
  if (status >= 500) throw new UpstreamHttpError(PROVIDER, status, retryAfterMs(retryAfter, { dates: false, maxDigits: 6 }));
  throw new TransportError(PROVIDER, 'Flash Courier tracking is unavailable', { status });
}
export class FlashCourierTracker {
  constructor(private readonly environment: Pick<AdapterEnvironment, 'trawl'> & Partial<Pick<AdapterEnvironment, 'fetcher' | 'recorder'>>) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeFlashCourierNumber(raw), url = `${ORIGIN}/rastreio/${number}`, api = flashCourierApi(number);
    return runSteps({ carrier: 'flash-courier', signal: context.signal, recorder: this.environment.recorder,
      budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'Flash Courier needs the guest OCR tracking service');
      const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (timeoutMs < 1000) throw new BudgetExceededError(PROVIDER, remainingMs);
      let page;
      try {
        page = await this.environment.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs, captureResponses: [api] },
          { provider: PROVIDER, timeoutMs, signal, fetcher: this.environment.fetcher, requireSolved: false, maxBytes: 2_000_000,
            allowHttpStatuses: [400, 401, 403, 404, 410, 422, 428, 429, 500, 502, 503, 504] });
      } catch (error) {
        signal.throwIfAborted();
        if (trawlOutOfTime(error)) throw new BudgetExceededError(PROVIDER, remainingMs);
        throw error;
      }
      signal.throwIfAborted();
      if (page.url !== url || ![2, 3].includes(page.tier)) return schema('Flash Courier left its guest tracker');
      let meta: unknown;
      try { meta = JSON.parse(page.html); } catch { return schema('Flash Courier guest helper is unavailable'); }
      if (!isRecord(meta) || meta.protocol !== PROTOCOL || meta.requestedNumber !== number) return schema('Flash Courier returned another guest session');
      // A later generation/HTTP failure must outrank an earlier refused CAPTCHA capture.
      if (meta.diagnostic !== null) {
        const d = meta.diagnostic;
        if (!isRecord(d)) return schema('Flash Courier returned invalid diagnostics');
        if (d.kind === 'http' && Number.isInteger(d.status) && Number(d.status) >= 100 && Number(d.status) <= 599) return http(Number(d.status), d.retryAfter);
        if (d.kind === 'budget') throw new BudgetExceededError(PROVIDER, remainingMs);
        if (['captcha_refused', 'unreadable', 'stale_challenge'].includes(String(d.kind))) throw new ChallengeError(PROVIDER, 'Flash Courier did not complete its image code', { reason: String(d.kind) });
        if (d.kind === 'transport') throw new TransportError(PROVIDER, 'Flash Courier guest transport failed');
        return schema('Flash Courier changed its guest form or response');
      }
      if (page.statusCode !== 200) return http(page.statusCode);
      if (!page.capturedResponses.length || page.capturedResponses.length > 2) return schema('Flash Courier did not capture a bounded reply');
      for (const row of page.capturedResponses) {
        if (row.url !== api || row.trackingNumberSubmitted !== number) return schema('Flash Courier captured another tracking query');
      }
      const row = page.capturedResponses.at(-1)!;
      if (row.status !== 200 && row.status !== 422) return http(row.status, row.headers['retry-after']);
      if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string') throw new TransportError(PROVIDER, 'Flash Courier returned an incomplete reply');
      if (row.body.length > 1_000_000) return schema('Flash Courier returned an oversized reply');
      let payload: unknown;
      try { payload = JSON.parse(row.body); } catch { return schema('Flash Courier returned invalid tracking JSON'); }
      if (row.status === 422 && (!isRecord(payload) || payload.kind !== 'captcha_refused')) return http(422);
      return parseFlashCourier(payload, number);
    } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new FlashCourierTracker(environment);
  return { id: 'flash-courier', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => accepted(() => normalizeFlashCourierNumber(number))
      ? recognizeFromBrowserLookup(() => tracker.fetch(number, context)) : Promise.resolve({ known: false, lastActivityAt: null }) };
};
