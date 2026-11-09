import { DateTime, FixedOffsetZone } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { alphastlineShipmentStage, alphastlineStage } from './status.js';

export const PROVIDER = 'Alphastline';
// A long history is a few kilobytes of JSON.
export const ALPHASTLINE_MAX_BYTES = 256 * 1024;

// AF, the initials of 傲飞, and 21 digits.
const NUMBER = /^AF\d{21}$/;
// "2026-11-03 09:36:34": a wall clock without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const SECONDS = /^\d{9,10}$/;
const NODE = /^[A-Za-z][A-Za-z_]{0,39}$/;
// The tracker's answer for an order it has nothing for.
const NOT_FOUND = /^unable to find\b/i;
const BUSY = /频繁|too many|rate limit/i;
const MAX_SHIPMENTS = 40;
const MAX_ROWS = 300;
// Offsets a zone can keep: whole quarter hours, at most 14 hours from UTC.
const MAX_OFFSET_MINUTES = 14 * 60;

/** An Alphastline order number in upper case, as the tracker reads it; anything else is not one Alphastline issues. */
export function normalizeAlphastlineNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Alphastline numbers are AF and 21 digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Alphastline returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's date and second as one wall time, or nothing when the reply gives none. */
function wallClock(raw: string): string | null {
  if (!raw) return null;
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Alphastline returned an invalid scan time');
  }
  return local;
}

/** A scan's instant in epoch seconds, or nothing when the reply gives none. */
function instant(row: Record<string, unknown>): number | null {
  const value = row.operateTimestamp;
  if (value === null || value === undefined || value === '') return null;
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && SECONDS.test(value) ? Number(value) : Number.NaN;
  const parsed = Number.isSafeInteger(seconds) ? epochSecondsTime(seconds) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Alphastline returned an invalid scan timestamp');
  return parsed.timestamp;
}

/**
 * A scan's time. Each scan gives its instant and the wall clock it reads on: the
 * instant keeps that clock's offset, which the two give together. When they do not
 * give a zone's offset, the instant stands alone, in UTC; a scan with only its wall
 * clock keeps it as one.
 */
function scanTime(row: Record<string, unknown>): { at: number; event: Pick<CarrierEvent, 'time' | 'local_time'> } {
  const wall = wallClock(text(row, 'operateTime', 32));
  const at = instant(row);
  if (at === null) {
    if (!wall) throw new SchemaError(PROVIDER, 'Alphastline returned a scan without a time');
    return { at: Date.parse(`${wall}Z`), event: { local_time: wall } };
  }
  const offset = wall ? (Date.parse(`${wall}Z`) - at) / 60_000 : Number.NaN;
  const zone = Number.isInteger(offset) && offset % 15 === 0 && Math.abs(offset) <= MAX_OFFSET_MINUTES
    ? FixedOffsetZone.instance(offset) : FixedOffsetZone.utcInstance;
  return { at, event: { time: DateTime.fromMillis(at, { zone }).toISO({ suppressMilliseconds: true })! } };
}

/**
 * The number of the line Alphastline hands the parcel to and that line's carrier, when it
 * is not the number asked and one carrier's high-confidence rule claims it: the reply names
 * no carrier.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const line = normalizeTrackingNumber(text(shipment, 'mailNo', 64));
  if (!/^[A-Z0-9]{4,40}$/.test(line) || line === number) return {};
  const detected = detectCarrierMatch(line);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'alphastline'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: line } : {};
}

/** The stage the parcel is at: its newest staged scan, unless the shipment's status says it is further on. */
function currentStage(scan: CarrierEvent | undefined, status: string): { stage: Stage; source: string } | null {
  const scanned = scan ? { stage: scan.stage as Stage, source: scan.stage_source! } : null;
  const listed = alphastlineShipmentStage(status);
  if (!listed) return scanned;
  const shipment = { stage: listed, source: 'carrier_map' };
  if (!scanned || listed === 'delivered') return shipment;
  if (listed === 'exception') return scanned.stage === 'delivered' || scanned.stage === 'returned' ? scanned : shipment;
  return listed === 'in_transit' && scanned.stage === 'registered' ? shipment : scanned;
}

/**
 * The reply of the home page's tracking query: `trackingData.All.arr` lists one entry per
 * order asked, with the order's number (`erpOrderCode`), its status, the countries it ships
 * from and to, the line's number once it has one (`mailNo`) and the scans, each a wall clock,
 * its instant, a wording and a node. One the tracker has nothing for has no scans and says so
 * in `errMsg`. The entry must be the number asked.
 */
export function parseAlphastline(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAlphastlineNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Alphastline returned an invalid envelope');
  const all = isRecord(payload.trackingData) ? payload.trackingData.All : undefined;
  if (!isRecord(all)) {
    const message = clean(payload.message ?? payload.msg, 200);
    if (BUSY.test(message)) throw new RateLimitedError(PROVIDER);
    if (payload.trackingData === undefined && (message || payload.code !== undefined)) {
      throw new IndeterminateError(PROVIDER, 'Alphastline did not complete the lookup');
    }
    throw new SchemaError(PROVIDER, 'Alphastline returned an invalid envelope');
  }
  const entries = all.arr;
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SHIPMENTS || !entries.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Alphastline returned an invalid result list');
  }
  const shipment = (entries as Record<string, unknown>[]).find((candidate) => normalizeTrackingNumber(text(candidate, 'erpOrderCode', 64)) === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'Alphastline answered for another shipment');
  const rows = shipment.detail ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Alphastline returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Alphastline returned too many scans');
  const status = text(shipment, 'status', 32);
  const error = text(shipment, 'errMsg');
  if (!rows.length) {
    if (NOT_FOUND.test(error) && (!status || status === 'Default')) throw new NotFoundError(PROVIDER);
    if (error) throw new IndeterminateError(PROVIDER, 'Alphastline did not complete the lookup');
    throw new NoHistoryError(PROVIDER);
  }

  const scans: { at: number; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Alphastline returned an invalid scan');
    const { at, event: time } = scanTime(row);
    const description = text(row, 'operateDesc');
    if (!description) throw new SchemaError(PROVIDER, 'Alphastline returned a scan without wording');
    const node = text(row, 'operateNode', 40);
    if (node && !NODE.test(node)) throw new SchemaError(PROVIDER, 'Alphastline returned an invalid scan node');
    const identity = JSON.stringify([at, node, description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const staged = alphastlineStage(node || null, description);
    scans.push({ at, event: {
      ...time,
      description,
      ...(node ? { provider_code: node } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; equal times keep the reply's order.
  scans.sort((left, right) => right.at - left.at);
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const current = currentStage(events.find((event) => event.stage), status);
  const country = countryCode(text(shipment, 'shipTo', 8));
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(country ? { destination_country: country } : {}),
    ...handoff(shipment, number),
    events,
  };
}
