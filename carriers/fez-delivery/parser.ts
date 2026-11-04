import { isFezDeliveryReference } from '../../core/detection/fezDelivery.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { fezDeliveryStage } from './status.js';

export const PROVIDER = 'Fez Delivery';

export function normalizeFezDeliveryNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Fez Delivery needs a shipment reference');
  if (!isFezDeliveryReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function field(row: JsonObject, key: string, max = 500): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new SchemaError(PROVIDER, 'Fez Delivery returned an invalid tracking field');
  return clean(value);
}

function clock(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'Fez Delivery returned an invalid scan clock');
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
}

function description(row: JsonObject, alias: string): string {
  const raw = field(row, 'statusDescription', 2000).split(/\bReason\s*:/i, 1)[0]!.trim();
  // These public activity sentences are separate from rider comments and recipient details.
  const safe = new Set([
    'Your package has been successfully delivered to the recipient.',
    'Your package is on its way to the delivery address.',
    'We could not deliver your item after three unsuccessful attempts',
    'Our dispatch driver attempted to deliver the package but was unable to do so.',
    'Our rider has picked-up your item and is heading back to the office',
  ]);
  return alias + (safe.has(raw) && normalizeStatusWording(raw) !== normalizeStatusWording(alias) ? ` — ${raw}` : '');
}

export function parseFezDelivery(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFezDeliveryNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Fez Delivery returned no tracking envelope');
  if (payload.status === 'Error') {
    if (payload.description === 'Order Not Found' && payload.history === ''
      && Object.keys(payload).every(key => ['status', 'description', 'history'].includes(key))) throw new NotFoundError(PROVIDER);
    const message = typeof payload.description === 'string' ? payload.description.slice(0, 1000) : '';
    if (/rate limit|too many requests/i.test(message)) throw new RateLimitedError(PROVIDER);
    if (/captcha|verification|blocked/i.test(message)) throw new ChallengeError(PROVIDER, 'Fez Delivery requires verification');
    throw new IndeterminateError(PROVIDER, 'Fez Delivery did not complete the lookup');
  }
  if (payload.status !== 'Success' || payload.description !== 'History Fetched' || !isRecord(payload.order)
    || typeof payload.order.orderNo !== 'string' || payload.order.orderNo.length > 64 || normalizeTrackingNumber(payload.order.orderNo) !== number
    || !Array.isArray(payload.history) || payload.history.length > 500) throw new SchemaError(PROVIDER, 'Fez Delivery returned another shipment or changed its history');
  const summary = field(payload.order, 'orderStatusAlias', 200);
  if (!payload.history.length) throw new NoHistoryError(PROVIDER, 'Fez Delivery returned no dated history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let firstAlias = '';
  for (const [index, row] of payload.history.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Fez Delivery returned an invalid scan');
    const alias = field(row, 'orderStatusAlias', 200), code = field(row, 'orderStatus', 200);
    if (index === 0) firstAlias = alias;
    const event: CarrierEvent = { local_time: clock(field(row, 'statusCreationDate', 64)), provider_code: code, description: description(row, alias) };
    const stage = fezDeliveryStage(code);
    if (stage) { event.stage = stage; event.stage_source = 'carrier_map'; }
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (normalizeStatusWording(summary) !== normalizeStatusWording(firstAlias)) throw new SchemaError(PROVIDER, 'Fez Delivery returned a contradictory current status');
  const newest = events[0]!, stage = fezDeliveryStage(newest.provider_code!);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: newest.provider_code, last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
