import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { airmeeLabel, airmeeStage, statusMap, type AirmeeShipment } from './status.js';

export const PROVIDER = 'Airmee';
export const CARRIER = 'airmee';
// A shipment with three delivery rounds and the van's position rows is about 10 kB.
export const AIRMEE_MAX_BYTES = 512 * 1024;

// Amazon's AM ids, Airmee's own six-character codes and the retailers' order numbers: letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
// "2025-09-08T12:23:53.52421+00:00": an instant with its offset, to a fraction of a second.
const INSTANT = /^(\d{4})-\d{2}-\d{2}T(\d{2}):\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CODE = /^[A-Z][A-Z_]{1,59}$/;
const EPOCH = /^\d{9,10}$/;
const COUNTRY = /^[A-Z]{2}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|The request is blocked|awswaf/i;
const MAX_ROWS = 500;
// The shipment's status once Airmee's part is over: an estimate no longer holds.
const CLOSED = new Set(['DROPOFF_CONFIRMED', 'CANCELLED']);

/** A number for Airmee's tracker: letters and digits, in capitals, with at least one digit. */
export function normalizeAirmeeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Airmee looks shipments up by 4 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isAirmeeBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('Airmee returned an invalid field');
  return clean(value, max);
}

/**
 * An instant as the reply writes it, with the offset it states, to the second; null when it is not one. Date
 * libraries accept hour 24, so the hour is checked here.
 */
function instant(value: unknown): { iso: string; timestamp: number } | null {
  const parts = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!parts || Number(parts[1]) < 2000 || Number(parts[2]) > 23) return null;
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  if (!parsed.isValid) return null;
  return { iso: parsed.startOf('second').toISO({ suppressMilliseconds: true }), timestamp: parsed.toMillis() };
}

interface Row {
  code: string;
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

interface RawRow {
  code: string;
  time: { iso: string; timestamp: number };
  leg: string;
  reason: string;
  locker: boolean;
  location: string;
}

/** One row as the reply writes it. The courier's position, the warehouse id and the booking changes are not read. */
function rawRow(value: unknown): RawRow {
  if (!isRecord(value)) return invalid('Airmee returned an invalid timeline row');
  const code = typeof value.status_ === 'string' ? value.status_.trim().toUpperCase() : '';
  if (!CODE.test(code)) return invalid('Airmee returned a timeline row without its status');
  const time = instant(value.time_of_event) ?? invalid('Airmee returned an invalid timeline time');
  const extra = isRecord(value.extra_information) ? value.extra_information : {};
  return {
    code, time,
    leg: text(extra.type_of_delivery, 40).toLowerCase(),
    reason: text(extra.reason, 300).replace(/_/g, ' '),
    locker: text(extra.type_of_service, 40) === 'parcel_locker',
    location: text(value.warehouse_name, 120) || text(extra.warehouse_name, 120),
  };
}

/**
 * Whether the return is on its way back, by the page's own test: a shipment turned into a return that has been
 * collected or delivered back, or that was sent back after its delivery attempts or its due date passed.
 */
function movingReturn(payload: Record<string, unknown>, rows: readonly unknown[]): boolean {
  if (payload.order_metadata !== 'return') return false;
  const courier = payload.courier_status;
  if (courier !== 'DROPOFF_CONFIRMED') {
    const reasons = rows.flatMap((row) => (isRecord(row) && row.status_ === 'UNASSIGNED' && isRecord(row.extra_information)
      && typeof row.extra_information.reason === 'string' ? [row.extra_information.reason.toLowerCase()] : []));
    if (reasons.some((reason) => reason.includes('postponements') || reason.includes('due date'))) return true;
    if (reasons.some((reason) => reason.includes('damaged'))) return false;
  }
  return courier === 'DROPOFF_CONFIRMED' || courier === 'PICKUP_CONFIRMED' || courier === 'POSTPONED_OTHER';
}

/**
 * The rows, newest first, each worded and staged as the page words it. A row that does not name its leg, as an
 * older history's warehouse scans do not, is on the leg of the row before it. A run of the same row, as the
 * tracker repeats while the van drives, keeps its first.
 */
function rowsOf(raws: readonly RawRow[], shipment: AirmeeShipment): Row[] {
  const oldestFirst = raws.map((raw, index) => ({ raw, index }))
    .sort((a, b) => a.raw.time.timestamp - b.raw.time.timestamp || b.index - a.index);
  const rows: Row[] = [];
  let returnLeg = false;
  let previous = '';
  for (const { raw, index } of oldestFirst) {
    if (raw.leg) returnLeg = raw.leg === 'return';
    const description = airmeeLabel(raw.code, { returnLeg, reason: raw.reason, locker: raw.locker }, shipment);
    const same = `${raw.code}\n${description}\n${raw.location}`;
    if (same === previous) continue;
    previous = same;
    const stage = airmeeStage(raw.code, description);
    rows.push({
      code: raw.code, timestamp: raw.time.timestamp, index,
      event: {
        time: raw.time.iso, description, ...(raw.location ? { location: raw.location } : {}), provider_code: raw.code,
        ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
      },
    });
  }
  return rows.reverse();
}

type Estimate = Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from' | 'unread_estimates'>;

/** A time the reply gives in seconds since the epoch, in the recipient's zone. */
function epoch(value: unknown, zone: string): { iso: string; timestamp: number } | null {
  const digits = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof digits !== 'string' || !EPOCH.test(digits)) return null;
  const parsed = DateTime.fromSeconds(Number(digits), { zone });
  return parsed.isValid ? { iso: parsed.toISO({ suppressMilliseconds: true }), timestamp: parsed.toMillis() } : null;
}

/**
 * The drop-off window the page shows, for a delivery not yet made. A window that is not two times in order is
 * named as unread.
 */
function estimate(payload: Record<string, unknown>): Estimate {
  const fields = { dropoff_earliest_time: payload.dropoff_earliest_time, dropoff_latest_time: payload.dropoff_latest_time };
  if ((fields.dropoff_earliest_time ?? null) === null && (fields.dropoff_latest_time ?? null) === null) return { expected_delivery: null };
  const named = typeof payload.recipient_timezone === 'string' ? payload.recipient_timezone : '';
  const zone = named && DateTime.local().setZone(named).isValid ? named : 'Europe/Stockholm';
  const from = epoch(fields.dropoff_earliest_time, zone);
  const to = epoch(fields.dropoff_latest_time, zone);
  if (!from || !to || from.timestamp > to.timestamp) return { expected_delivery: null, ...unreadEstimates(fields) };
  return { expected_delivery: to.iso, ...(from.timestamp < to.timestamp ? { expected_delivery_from: from.iso } : {}) };
}

/**
 * The shipment inside the reply of `api.airmee.com/track/public_track_shipment`, the lookup Airmee's tracking
 * page makes: a wrapper with a status code and the shipment as a JSON string, `{}` for an id the tracker does
 * not hold.
 */
export function airmeeShipment(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.body !== 'string') return invalid('Airmee returned an unexpected reply');
  if (payload.statusCode !== 200) throw new IndeterminateError(PROVIDER, 'Airmee did not complete the lookup');
  let shipment: unknown;
  try {
    shipment = JSON.parse(payload.body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Airmee returned a shipment that is not JSON', { cause });
  }
  if (!isRecord(shipment)) return invalid('Airmee returned an unexpected shipment');
  // The tracker's answer for an id it holds nothing for in the date range asked: an empty shipment.
  if (!Object.keys(shipment).length) throw new NotFoundError(PROVIDER);
  return shipment;
}

/**
 * Airmee's shipment as its tracking page reads it. It repeats the shipment id and names the retailer, the
 * destination country, the shipment's courier status, whether it became a return, the drop-off window, and the
 * timeline newest first: each row a courier status code, an instant with its offset, the warehouse of a scan and
 * the leg, reason and service the page words it by. Instants keep the offset the reply states.
 *
 * The recipient's town and postcode, the courier's positions, the order id, the delivery options and the
 * booking changes are never read.
 */
export function parseAirmee(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAirmeeNumber(raw);
  const shipment = airmeeShipment(payload);
  if (typeof shipment.shipment_id !== 'string') return invalid('Airmee returned a shipment without its id');
  // The reply repeats the shipment id, in capitals whatever case was asked.
  if (normalizeTrackingNumber(shipment.shipment_id).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Airmee answered for another shipment');
  }
  if (shipment.events_timeline !== undefined && shipment.events_timeline !== null && !Array.isArray(shipment.events_timeline)) {
    return invalid('Airmee returned an invalid timeline');
  }
  const timeline = (shipment.events_timeline ?? []) as unknown[];
  if (timeline.length > MAX_ROWS) return invalid('Airmee returned too many timeline rows');
  const courier = typeof shipment.courier_status === 'string' ? shipment.courier_status.trim().toUpperCase() : '';
  const context: AirmeeShipment = { returnOrder: shipment.order_metadata === 'return', movingReturn: movingReturn(shipment, timeline) };
  const raws = timeline.map(rawRow);
  const rows = rowsOf(raws, context);
  const events = rows.map(({ event }) => event);

  // A retailer's return booked from the start goes to the retailer: it names the parcel's receiver, not its sender.
  const store = text(shipment.store_name, 120);
  const oldestLeg = raws.map((row) => row.leg).filter(Boolean).at(-1);
  const sender = store && oldestLeg !== 'return' ? { sender_name: store } : {};
  const country = isRecord(shipment.receiver_details) && typeof shipment.receiver_details.country === 'string'
    ? shipment.receiver_details.country.trim().toUpperCase() : '';
  const destination = COUNTRY.test(country) ? { destination_country: country } : {};
  const open = !CLOSED.has(courier) && !context.returnOrder;

  const newest = events[0];
  if (!newest) {
    // A shipment without rows stands on its courier status, when the page words it.
    const label = CODE.test(courier) ? airmeeLabel(courier, { returnLeg: context.returnOrder, reason: '', locker: false }, context) : '';
    const stage = label ? airmeeStage(courier, label) : undefined;
    if (!stage) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map', provider_code: courier,
      last_status_text: label, last_update: null, ...(open ? estimate(shipment) : { expected_delivery: null }),
      ...sender, ...destination, summary_only: true, events: [],
    };
  }
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const finished = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(open && !finished ? estimate(shipment) : { expected_delivery: null }),
    ...sender,
    ...destination,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function airmeeJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isAirmeeBlocked(body)) throw new ChallengeError(PROVIDER, 'Airmee answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Airmee returned a reply that is not JSON', { cause });
  }
}
