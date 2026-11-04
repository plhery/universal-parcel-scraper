import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { qatarPostStage } from './status.js';

export const PROVIDER = 'Qatar Post';
export const QATAR_MAX_BYTES = 1_000_000;
export function normalizeQatarPostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isValidS10TrackingNumber(number)) throw new InvalidInputError(PROVIDER, 'Qatar Post guest tracking needs a valid postal S10 identifier');
  return number;
}

function text(row: Record<string, unknown>, key: string, max = 500): string {
  const value = row[key];
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, 'Qatar Post returned a malformed tracking field');
  return clean(value, max);
}
function identity(value: unknown, number: string): boolean {
  return typeof value === 'string' && value.length <= 64 && normalizeTrackingNumber(value) === number;
}
function clock(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  const day = m ? calendarDay(Number(m[3]), Number(m[1]), Number(m[2])) : null;
  if (!day || !m) throw new SchemaError(PROVIDER, 'Qatar Post returned an invalid scan clock');
  return `${day}T${m[4]}`;
}

/** HTTP status and number binding are required for the guest endpoint's explicit negative. */
export function parseQatarPostResponse(body: string, status: number, raw: string): CarrierResult {
  const number = normalizeQatarPostNumber(raw);
  if (new TextEncoder().encode(body).byteLength > QATAR_MAX_BYTES) throw new SchemaError(PROVIDER, 'Qatar Post returned an oversized response');
  if (status === 403) throw new ChallengeError(PROVIDER, 'Qatar Post refused its public guest request');
  if (/^\s*</.test(body)) {
    if (/Request Rejected|captcha|_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied)|verify.*human/i.test(body)) throw new ChallengeError(PROVIDER, 'Qatar Post returned browser verification');
    throw new SchemaError(PROVIDER, 'Qatar Post returned HTML instead of tracking JSON');
  }
  if (status === 404) {
    if (body.trim() === `Order with tracking number : ${number} Does not exist`) throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'Qatar Post returned an unbound missing-route response', { status });
  }
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'Qatar Post returned unreadable tracking JSON'); }
  if (isRecord(payload) && payload.message === 'Invalid token') throw new ChallengeError(PROVIDER, 'Qatar Post refused guest verification');
  if (status !== 200) throw new TransportError(PROVIDER, 'Qatar Post could not answer guest tracking', { status });
  return parseQatarPost(payload, number);
}

export function parseQatarPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeQatarPostNumber(raw);
  if (!isRecord(payload) || !identity(payload.trackingNumber, number) || !identity(payload.orderAWBNumber, number)
    || !isRecord(payload.otherDetails) || !Array.isArray(payload.otherDetails.response)
    || !payload.otherDetails.response.length || payload.otherDetails.response.length > 10) throw new SchemaError(PROVIDER, 'Qatar Post returned no matching tracking envelope');
  const matches = payload.otherDetails.response.filter((row: unknown) => isRecord(row) && isRecord(row.line_item_dtls)
    && identity(row.line_item_dtls.tracking_number, number));
  if (matches.length !== 1 || !isRecord(matches[0])) throw new SchemaError(PROVIDER, 'Qatar Post returned no unique matching shipment');
  const detail = matches[0];
  if (!Array.isArray(detail.track_trace_details) || detail.track_trace_details.length > 500
    || !Number.isSafeInteger(detail.total_count) || Number(detail.total_count) < detail.track_trace_details.length
    || Number(detail.total_count) > 10_000 || !isRecord(payload.currentStatus)) throw new SchemaError(PROVIDER, 'Qatar Post changed its shipment history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of detail.track_trace_details) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Qatar Post returned a malformed scan');
    const description = text(row, 'event_name_en') || text(row, 'event_name_ar');
    const code = text(row, 'event_code', 32), location = text(row, 'branch', 160);
    if (!description || !/^[A-Z0-9]{1,32}$/.test(code)) throw new SchemaError(PROVIDER, 'Qatar Post returned an unnamed scan');
    const local = clock(text(row, 'date_time', 40)), key = JSON.stringify([local, description, code, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = qatarPostStage(code, description);
    events.push({ local_time: local, description, provider_code: code, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // The app returns oldest first, including origin scans. Retain its sequence without comparing different facility zones.
  events.reverse();
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Qatar Post returned no dated shipment scans');
  const summary = text(payload.currentStatus, 'currentStatusDescription');
  const summaryCode = payload.currentStatus.currentStatusCode;
  if (!Number.isSafeInteger(summaryCode) || Number(summaryCode) < 0 || Number(summaryCode) > 10_000 || !summary) throw new SchemaError(PROVIDER, 'Qatar Post changed its current status');
  const headline = qatarPostStage(String(summaryCode), summary), staged = headline ?? qatarPostStage(newest.provider_code!, newest.description!);
  const incomplete = Number(detail.total_count) > detail.track_trace_details.length || events.length > 100
    || !!(headline && headline.stage !== newest.stage);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: headline ? summary : newest.description, provider_code: String(summaryCode),
    last_update: null, last_update_local: newest.local_time, ...(incomplete ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
