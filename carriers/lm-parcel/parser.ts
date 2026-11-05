import { DateTime } from 'luxon';
import { isLmParcelReference } from '../../core/detection/lmParcel.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { lmParcelStage } from './status.js';

export const PROVIDER = 'LM Parcel';
export const LM_PARCEL_BASE = 'https://www.lmparcel.com/route-soa/route/';

export function normalizeLmParcelNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'LM Parcel needs a parcel reference');
  if (!isLmParcelReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid tracking field');
  return clean(value, limit);
}

function identity(value: unknown): string { return normalizeTrackingNumber(text(value, 64)); }
function empty(value: unknown): boolean { return value === undefined || value === null || value === ''; }

function envelope(payload: unknown): unknown[] {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'LM Parcel returned no tracking envelope');
  if (typeof payload.code !== 'string' && typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'LM Parcel returned no response code');
  if ([429, '429'].includes(payload.code)) throw new RateLimitedError(PROVIDER);
  if ([401, 403, '401', '403'].includes(payload.code)) throw new ChallengeError(PROVIDER, 'LM Parcel refused public tracking');
  if (payload.code !== 0 && payload.code !== '0') throw new IndeterminateError(PROVIDER, 'LM Parcel did not complete the lookup');
  if (payload.success !== true || payload.error != null || payload.errors != null || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'LM Parcel returned a mixed tracking envelope');
  return payload.data as unknown[];
}

/** The one-item search must bind its query before either absence or a details request. */
export function parseLmParcelSummary(payload: unknown, raw: string): JsonObject {
  const number = normalizeLmParcelNumber(raw), rows = envelope(payload);
  if (rows.length !== 1 || !isRecord(rows[0]) || identity(rows[0].searchNo) !== number) throw new SchemaError(PROVIDER, 'LM Parcel returned another requested reference');
  const row = rows[0];
  if (row.status === 1) {
    if (row.waybillNo === null && row.originTime === 0 && row.occurTime === 0
      && ['originCountry', 'targetCountry', 'routeType', 'routeContent', 'occurCountry', 'occurAddr'].every(key => row[key] === null)
      && ['channelId', 'channelCode',
        'requestMessage', 'responseMessage', 'pullTrackSource', 'trackSourceDesc'].every(key => empty(row[key]))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'LM Parcel returned a mixed absence record');
  }
  if (identity(row.waybillNo) !== number || ![2, 3, 4, 5].includes(row.status as number)) throw new SchemaError(PROVIDER, 'LM Parcel returned an unbound parcel');
  return row;
}

function code(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 99999) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid scan code');
  return String(value);
}

function clock(value: unknown, rawZone: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid scan clock');
  // The API encodes facility wall digits as a China-clock epoch. The row's offset
  // belongs to those digits, not to that epoch (confirmed against the delivering carrier).
  const decoded = DateTime.fromMillis(value, { zone: 'Asia/Shanghai' });
  if (!decoded.isValid || decoded.year < 2000 || decoded.year > 2100) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid scan date');
  const wall = decoded.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const zone = empty(rawZone) ? '' : text(rawZone, 64);
  if (/^[+-]\d{2}:\d{2}$/.test(zone)) {
    if (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(zone) || /^[+-]14:(?!00)/.test(zone)) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid scan offset');
    const instant = explicitOffsetTime(wall + zone);
    if (!instant) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid scan offset');
    return { time: instant.iso };
  }
  return { local_time: wall };
}

function wording(row: JsonObject, references: Set<string>): string {
  const raw = text(row.routeContent);
  if (row.routeType === 430) {
    const match = /^Last mile,\s*tracking number\s+([A-Z0-9]{5,40})\s*$/i.exec(raw);
    if (!match || !/\d/.test(match[1]!)) throw new SchemaError(PROVIDER, 'LM Parcel returned an invalid last-mile reference');
    references.add(normalizeTrackingNumber(match[1]!));
    return 'Last mile tracking number assigned';
  }
  const value = raw.split(/https?:\/\/|\b(?:position|recipient|consignee|signed\s+by|received\s+by|phone)\s*[:：]|签收人|收件人|电话/i, 1)[0]!.trim();
  if (!value || /[<>@]|\+\d[\d ()-]{6,}|\d{8,}/.test(value)) throw new SchemaError(PROVIDER, 'LM Parcel returned no logistics description');
  return value;
}

function location(row: JsonObject): string {
  if (empty(row.occurAddr)) return '';
  const value = text(row.occurAddr, 250).replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/[ ,]+$/, '').trim();
  return /[<>@]|https?:|\d{7,}|\b(?:recipient|phone|street|road|avenue|apartment|address)\b|收件人|电话|地址/i.test(value) ? '' : value;
}

export function parseLmParcel(summaryPayload: unknown, detailsPayload: unknown, raw: string): CarrierResult {
  const number = normalizeLmParcelNumber(raw), summary = parseLmParcelSummary(summaryPayload, number), rows = envelope(detailsPayload);
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'LM Parcel returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'LM Parcel returned no dated history');
  const references = new Set<string>(), seen = new Set<string>(), events: CarrierEvent[] = [];
  const summaryEvents = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || identity(row.waybillNo) !== number) throw new SchemaError(PROVIDER, 'LM Parcel returned another parcel in its history');
    const providerCode = code(row.routeType), description = wording(row, references), stage = lmParcelStage(providerCode, description), place = location(row);
    const event: CarrierEvent = { ...clock(row.occurTime, row.timeZone), description, provider_code: providerCode,
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (row.routeType === summary.routeType && row.occurTime === summary.occurTime) summaryEvents.add(key);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!summaryEvents.size) throw new SchemaError(PROVIDER, 'LM Parcel returned a summary outside its history');
  // Correcting the clocks can change the raw order across the ocean. A local
  // clock without an offset cannot be placed among instants, so keep source order then.
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const newest = events[0]!, stage = lmParcelStage(newest.provider_code ?? null, newest.description!);
  const summaryIsNewest = summaryEvents.has(JSON.stringify(newest));
  if (summaryIsNewest && stage && ((summary.status === 4 && stage !== 'delivered') || (summary.status !== 4 && stage === 'delivered'))) {
    throw new SchemaError(PROVIDER, 'LM Parcel returned contradictory delivery states');
  }
  const origin = countryCode(empty(summary.originCountry) ? '' : text(summary.originCountry, 100));
  const destination = countryCode(empty(summary.targetCountry) ? '' : text(summary.targetCountry, 100));
  references.delete(number);
  const partner = references.size === 1 ? [...references][0] : undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: newest.provider_code, last_status_text: newest.description, last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}), expected_delivery: null,
    ...(origin ? { origin_country: origin } : {}), ...(destination ? { destination_country: destination } : {}),
    ...(partner ? { delivery_tracking_number: partner } : {}), ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
