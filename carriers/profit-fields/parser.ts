import { isProfitFieldsReference } from '../../core/detection/profitFields.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { profitFieldsStage } from './status.js';

export const PROVIDER = 'Profit Fields';
export const PROFIT_FIELDS_ENDPOINT = 'https://8dt.com/api/tracking/query';

export function normalizeProfitFieldsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Profit Fields needs a parcel reference');
  if (!isProfitFieldsReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new SchemaError(PROVIDER, 'Profit Fields returned an invalid tracking field');
  return clean(value, limit);
}

function identity(row: JsonObject, key: string): string {
  return normalizeTrackingNumber(text(row[key], 64));
}

function state(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) throw new SchemaError(PROVIDER, 'Profit Fields returned an invalid scan state');
  return value;
}

function clock(raw: unknown, rawZone: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const value = text(raw, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'Profit Fields returned an invalid scan clock');
  const wall = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
  const zone = rawZone === null || rawZone === undefined ? '' : text(rawZone, 64);
  const offset = /^\(UTC ([+-]\d{2}:\d{2})\)$/.exec(zone);
  if (offset) {
    const instant = explicitOffsetTime(wall + offset[1]);
    if (!instant || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset[1]!)
      || /^[-+]14:(?!00)/.test(offset[1]!)) throw new SchemaError(PROVIDER, 'Profit Fields returned an invalid scan offset');
    return { time: instant.iso };
  }
  return { local_time: wall };
}

function description(row: JsonObject): string {
  const english = row.eventEn === null || row.eventEn === undefined ? '' : text(row.eventEn);
  const chinese = row.eventCn === null || row.eventCn === undefined ? '' : text(row.eventCn);
  const wording = (english || chinese).split(/https?:\/\/|(?:recipient|consignee|signed\s+by|received\s+by|phone|签收人|收件人|电话)\s*[:：]?/i, 1)[0]!.trim();
  if (!wording || /[<>@]|\+\d[\d ()-]{6,}|\d{8,}/.test(wording)) throw new SchemaError(PROVIDER, 'Profit Fields returned no logistics description');
  return wording;
}

export function parseProfitFields(payload: unknown, raw: string): CarrierResult {
  const number = normalizeProfitFieldsNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Profit Fields returned no tracking envelope');
  if (payload.code === 429) throw new RateLimitedError(PROVIDER);
  if ([401, 403].includes(payload.code)) throw new ChallengeError(PROVIDER, 'Profit Fields refused public tracking');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'Profit Fields did not complete the lookup');
  if (!isRecord(payload.data) || !Array.isArray(payload.data.items) || payload.data.items.length !== 1) throw new SchemaError(PROVIDER, 'Profit Fields returned no unique tracking record');
  const record: unknown = payload.data.items[0];
  if (!isRecord(record) || identity(record, 'queryNumber') !== number || identity(record, 'id') !== number) throw new SchemaError(PROVIDER, 'Profit Fields returned another requested reference');
  if (record.found === false) {
    if (record.status === 'notfound' && record.carrier === '' && Array.isArray(record.timeline) && !record.timeline.length
      && Array.isArray(record.flowLayout) && !record.flowLayout.length
      && ['number', 'trackingNumber', 'transferNumber', 'orderId', 'customerOrderNo'].every(key => record[key] === undefined || record[key] === null || record[key] === '')) {
      throw new NotFoundError(PROVIDER);
    }
    throw new SchemaError(PROVIDER, 'Profit Fields returned a mixed absence record');
  }
  if (record.found !== true || identity(record, 'trackingNumber') !== number || !Array.isArray(record.timeline)
    || record.timeline.length > 500) throw new SchemaError(PROVIDER, 'Profit Fields returned an unbound parcel or invalid history');
  if (!record.timeline.length) throw new NoHistoryError(PROVIDER, 'Profit Fields returned no dated history');
  const summary = state(record.nodeStatus), events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of record.timeline as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Profit Fields returned an invalid scan');
    const code = state(row.nodeStatus), wording = description(row), stage = profitFieldsStage(code, wording);
    const location = row.location === null || row.location === undefined ? '' : text(row.location, 250);
    const safeLocation = !/[<>@]|https?:|\d{7,}|\b(?:recipient|phone|street|road|avenue|apartment|address)\b|收件人|电话|地址/i.test(location) ? location : '';
    const event: CarrierEvent = { ...clock(row.time, row.timeZone), description: wording,
      ...(code ? { provider_code: code } : {}), ...(safeLocation ? { location: safeLocation } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const newest = events[0]!;
  if (summary !== (newest.provider_code ?? null)) throw new SchemaError(PROVIDER, 'Profit Fields returned a contradictory current state');
  const stage = profitFieldsStage(summary, newest.description!);
  if (record.status === 'delivered' && stage && stage !== 'delivered') throw new SchemaError(PROVIDER, 'Profit Fields returned contradictory delivery states');
  let partner: string | undefined;
  if (record.transferNumber !== null && record.transferNumber !== undefined && record.transferNumber !== '') {
    partner = identity(record, 'transferNumber');
    if (!/^(?=.*\d)[A-Z0-9]{5,40}$/.test(partner)) throw new SchemaError(PROVIDER, 'Profit Fields returned an invalid partner reference');
  }
  const destination = record.destination === null || record.destination === undefined ? '' : text(record.destination, 100);
  const country = countryCode(destination);
  // `carrier` is a commodity label, not the delivery company. Keep the declared transfer number whole.
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(summary ? { provider_code: summary } : {}), last_status_text: newest.description, last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}), expected_delivery: null,
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...(partner && partner !== number ? { delivery_tracking_number: partner } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
