import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap, wldStage } from './status.js';

export const PROVIDER = 'WLD Express';
// A long history is a few kilobytes of JSON.
export const WLD_MAX_BYTES = 256 * 1024;

// WLD, two letters and ten digits: the numbers WLD's tracker answers with its scans.
const NUMBER = /^WLD[A-Z]{2}\d{10}$/;
// "2026-08-07 18:05:26": a wall clock without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^[A-Z]{1,12}$/;
// The answer for a number the tracker does not hold, in English and in Chinese.
const NO_CODE = /^(?:Code does not exist|单号不存在)$/i;
const BUSY = /频繁|too many|rate limit/i;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;

/** A WLD number in upper case, as the tracker reads it; anything else is not one WLD issues. */
export function normalizeWldNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'WLD Express numbers are WLD, two letters and ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `WLD Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's date and second as one wall time. The reply gives no zone. */
function wallClock(raw: string): string {
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'WLD Express returned an invalid scan time');
  }
  return local;
}

/** A line's place is its office, a bar, then its town: "office|town" reads "office, town". */
function place(raw: string): string {
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/**
 * The number the line WLD hands the parcel to gave it, when it is not the
 * number asked: the page shows it as the tracking number. The reply names no
 * line, so its carrier is named only when one carrier's high-confidence rule
 * claims the number.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const line = normalizeTrackingNumber(text(shipment, 'server_hawbcode', 64));
  if (!/^[A-Z0-9]{4,40}$/.test(line) || !/\d/.test(line) || line === number) return {};
  const detected = detectCarrierMatch(line);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'wld-express'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: line } : { delivery_tracking_number: line };
}

/**
 * The reply of the tracker page's `getTrackInfoOutside` call: `detail['']`
 * lists one entry per number asked. A number the tracker knows is `ask: 1`
 * with the shipment: WLD's number (`shipper_hawbcode`), the line's
 * (`server_hawbcode`), the destination's code and the scans, newest first,
 * each a wall clock, a place, a wording and a code. One it does not hold is
 * `ask: 0`. The shipment must be the number asked. The recipient's name and
 * town and the customer's reference are not read.
 */
export function parseWld(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWldNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'WLD Express returned an invalid envelope');
  if (payload.code !== 200) {
    if (BUSY.test(clean(payload.message, 200))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'WLD Express did not complete the lookup');
  }
  const detail = isRecord(payload.data) ? payload.data.detail : undefined;
  const entries = isRecord(detail) ? detail[''] : undefined;
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SHIPMENTS || !entries.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'WLD Express returned an invalid result list');
  }
  const entry = (entries as Record<string, unknown>[]).find((candidate) => normalizeTrackingNumber(text(candidate, 'code', 64)) === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'WLD Express answered for another shipment');
  if (entry.ask === 0) {
    if (NO_CODE.test(text(entry, 'message'))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'WLD Express did not complete the lookup');
  }
  const shipment = entry.data;
  if (entry.ask !== 1 || !isRecord(shipment)) throw new SchemaError(PROVIDER, 'WLD Express returned an invalid shipment');
  if (normalizeTrackingNumber(text(shipment, 'shipper_hawbcode', 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'WLD Express answered for another shipment');
  }
  const rows = shipment.track_detail_list ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'WLD Express returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'WLD Express returned too many scans');

  const scans: { local: string; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'WLD Express returned an invalid scan');
    const local = wallClock(text(row, 'track_date', 32));
    const description = text(row, 'track_content');
    if (!description) throw new SchemaError(PROVIDER, 'WLD Express returned a scan without wording');
    const code = text(row, 'track_code', 32);
    if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'WLD Express returned an invalid scan code');
    const location = place(text(row, 'track_location', 160));
    const identity = JSON.stringify([local, code, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const staged = wldStage(code || null, description);
    scans.push({ local, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  const partner = handoff(shipment, number);
  if (!scans.length) throw new NoHistoryError(PROVIDER, undefined, {
    deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number,
  });
  // The tracker lists scans newest first, including across local clock changes.
  // Reverse an oldest-first reply only if even the full UTC offset range cannot reverse its endpoints.
  if (Date.parse(scans.at(-1)!.local + 'Z') - Date.parse(scans[0]!.local + 'Z') > 26 * 3_600_000) scans.reverse();
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  // A delivery stands only while no newer scan may have undone it, unless that scan moves nothing (`leadingScan`).
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  const country = countryCode(text(shipment, 'country_code', 8));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: scans[0]!.local,
    ...(country ? { destination_country: country } : {}),
    ...partner,
    events,
  };
}
