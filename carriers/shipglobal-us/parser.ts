import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isShipglobalUsReference } from '../../core/detection/shipglobalUs.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { shipglobalUsStage } from './status.js';

export const PROVIDER = 'ShipGlobal US';
export const SHIPGLOBAL_US_ENDPOINT = 'https://api.shipglobal.us/api/tracking';

export function normalizeShipglobalUsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'ShipGlobal US needs a shipment reference');
  if (!isShipglobalUsReference(number)) throw new NoHistoryError(PROVIDER, 'The US guest lookup needs its own FFUSA reference', { reason: 'unsupported_reference' });
  return number;
}

function field(row: JsonObject, key: string, optional = false): string {
  const value = row[key];
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.length > 1000 || !value.trim()) throw new SchemaError(PROVIDER, 'ShipGlobal US returned an invalid tracking field');
  return clean(value);
}

function clock(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'ShipGlobal US returned an invalid scan clock');
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
}

export function parseShipglobalUs(payload: unknown, raw: string, httpStatus = 200): CarrierResult {
  const number = normalizeShipglobalUsNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'ShipGlobal US returned no tracking envelope');
  if (httpStatus === 400 && payload.message === 'Invalid tracking number' && Object.keys(payload).length === 1) {
    // This reply also covers malformed inputs and does not prove shipment absence.
    throw new NoHistoryError(PROVIDER, 'ShipGlobal US has no available history', { reason: 'portal_not_found' });
  }
  if (payload.response !== 'success') {
    const message = typeof payload.message === 'string' ? payload.message.slice(0, 1000) : '';
    if (/rate limit|too many requests/i.test(message)) throw new RateLimitedError(PROVIDER);
    if (/captcha|verification|blocked/i.test(message)) throw new ChallengeError(PROVIDER, 'ShipGlobal US requires verification');
    if (typeof payload.response === 'string') throw new IndeterminateError(PROVIDER, 'ShipGlobal US did not complete the lookup');
    throw new SchemaError(PROVIDER, 'ShipGlobal US returned an invalid tracking envelope');
  }
  if (httpStatus !== 200 || !Array.isArray(payload.data) || payload.data.length !== 1) throw new SchemaError(PROVIDER, 'ShipGlobal US returned no unique shipment');
  const record: unknown = payload.data[0];
  if (!isRecord(record) || typeof record.waybill !== 'string' || record.waybill.length > 64 || normalizeTrackingNumber(record.waybill) !== number) {
    throw new SchemaError(PROVIDER, 'ShipGlobal US returned another shipment');
  }
  const summary = field(record, 'CurrentStatus');
  const keys = Object.keys(record).filter(key => /^\d+$/.test(key));
  if (keys.length > 500 || keys.some((key, index) => key !== String(index))) throw new SchemaError(PROVIDER, 'ShipGlobal US changed its checkpoint list');
  if (!keys.length) throw new NoHistoryError(PROVIDER, 'ShipGlobal US returned no dated checkpoints');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let firstCode = '';
  for (const [index, key] of keys.entries()) {
    const row = record[key];
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ShipGlobal US returned an invalid checkpoint');
    const code = field(row, 'status'), wording = field(row, 'description');
    if (index === 0) firstCode = code;
    const location = field(row, 'location', true);
    const description = wording.split(/https?:\/\/|(?:recipient|phone)\s*:/i, 1)[0]!.trim() || code;
    const stage = shipglobalUsStage(code);
    const event: CarrierEvent = { local_time: clock(field(row, 'date')), description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const dedupKey = JSON.stringify(event);
    if (!seen.has(dedupKey)) { seen.add(dedupKey); events.push(event); }
  }
  if (normalizeStatusWording(summary) !== normalizeStatusWording(firstCode)) throw new SchemaError(PROVIDER, 'ShipGlobal US returned a contradictory current status');
  const newest = events[0]!, stage = shipglobalUsStage(summary);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: summary, last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
