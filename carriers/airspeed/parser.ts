import { load } from 'cheerio';
import { isAirspeedReference } from '../../core/detection/airspeed.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { airspeedStage, isAirspeedAdministrative } from './status.js';

export const PROVIDER = 'Airspeed';
export function normalizeAirspeedNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Airspeed needs a cargo waybill');
  if (!isAirspeedReference(number)) throw new NoHistoryError(PROVIDER, 'The verified cargo route supports nine-digit waybills', { reason: 'unsupported_reference' });
  return number;
}
export function airspeedUrl(raw: string): string {
  return `https://logistics.airspeed.com.ph/track/TrackingSearch.aspx?${new URLSearchParams({ waybill: normalizeAirspeedNumber(raw) })}`;
}
function clock(value: string): string {
  const match = /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{4}) (0?[1-9]|1[0-2]):([0-5]\d):([0-5]\d) (AM|PM)$/i.exec(value);
  const day = match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Airspeed returned an invalid local scan clock');
  const hour = Number(match[4]) % 12 + (match[7]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${day}T${String(hour).padStart(2, '0')}:${match[5]}:${match[6]}`;
}
function wording(value: string): string {
  const text = clean(value, 1001);
  if (!text || text.length > 300 || /[<>@]|https?:|\d{7,}|\b(?:signed by|recipient|consignee|receiver|signature|phone)\b/i.test(text)) {
    throw new SchemaError(PROVIDER, 'Airspeed returned an invalid logistics status');
  }
  return text;
}
const LABELS = ['TRACKING NUMBER:', 'BOOKING DATE:', 'REFERENCE ID:', 'DESTINATION:', 'CURRENT SCANNING DATE/TIME:', 'CURRENT STATUS:'];

export function parseAirspeed(html: string, raw: string): CarrierResult {
  const number = normalizeAirspeedNumber(raw), $ = load(html); $('script,style,template').remove();
  const label = $('td').filter((_, el) => clean($(el).text()) === LABELS[0]);
  if (label.length !== 1) throw new SchemaError(PROVIDER, 'Airspeed returned no unique shipment summary');
  const rows = label.closest('table').children('tbody').children('tr');
  if (rows.length !== LABELS.length) throw new SchemaError(PROVIDER, 'Airspeed changed its shipment summary');
  const fields = new Map<string, ReturnType<typeof $>>();
  for (const row of rows.toArray()) {
    const cells = $(row).children('td'), key = clean(cells.first().text());
    if (cells.length !== 2 || !LABELS.includes(key) || fields.has(key)) throw new SchemaError(PROVIDER, 'Airspeed returned ambiguous shipment facts');
    fields.set(key, cells.eq(1));
  }
  const fact = (key: string) => clean(fields.get(key)!.text(), 1000);
  const bound = fact('TRACKING NUMBER:'), tables = $('#GridViewWaybillHistory');
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'Airspeed returned several histories');
  if (!bound && !tables.length && ['REFERENCE ID:', 'DESTINATION:', 'CURRENT SCANNING DATE/TIME:', 'CURRENT STATUS:'].every(key => !fact(key))) {
    // This empty view also invents a booking date from the server clock. It proves no booking or definite absence.
    throw new NoHistoryError(PROVIDER, 'The cargo tracker returned no retained shipment', { reason: 'expired_or_unknown' });
  }
  if (bound !== number) throw new SchemaError(PROVIDER, 'Airspeed returned another whole waybill');
  if (!tables.length) throw new NoHistoryError(PROVIDER, 'Airspeed knows the waybill but returned no history', { reason: 'parcel_found' });
  const scans = tables.children('tbody').children('tr'), header = scans.first().children('th').toArray().map(el => clean($(el).text()));
  if (header.join('|') !== 'DATE/TIME|STATUS|LOCATION/REMARKS' || scans.length > 501) throw new SchemaError(PROVIDER, 'Airspeed changed its history columns or exceeded the row limit');
  const events: CarrierEvent[] = [];
  for (const row of scans.slice(1).toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Airspeed changed a history row');
    const local_time = clock(clean(cells.eq(0).text(), 80)), description = wording(cells.eq(1).text());
    const stage = airspeedStage(null, description);
    // LOCATION/REMARKS mixes places with receiver/POD details; it is not a location field.
    events.push({ local_time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Airspeed returned no dated history', { reason: 'parcel_found' });
  const current = wording(fact('CURRENT STATUS:')), updated = clock(fact('CURRENT SCANNING DATE/TIME:'));
  const matches = (event: CarrierEvent) => event.local_time === updated && event.description === current;
  if (matches(events.at(-1)!)) events.reverse();
  else if (!matches(events[0]!)) throw new SchemaError(PROVIDER, 'Airspeed summary and history disagree');
  const seen = new Set<string>(), distinct = events.filter(event => { const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true; });
  const stage = airspeedStage(null, current) ?? (isAirspeedAdministrative(current) ? distinct.find(event => event.stage)?.stage as Stage | undefined : undefined);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current, last_update: null, last_update_local: updated, expected_delivery: null,
    ...(distinct.length > 100 ? { history_truncated: true } : {}), events: distinct.slice(0, 100) };
}
