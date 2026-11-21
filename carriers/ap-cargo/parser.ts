import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { apCargoStage } from './status.js';

export const PROVIDER = 'AP Cargo';
// A long history is a few kilobytes.
export const AP_CARGO_MAX_BYTES = 256 * 1024;
// The waybill number printed on AP Cargo's forms.
const NUMBER = /^\d{8}$/;
// A wall clock to the second; the reply gives no zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?$/;
// The fields of the record the tracker wraps in its answer for a number it does not hold, all null.
const RECORD_FIELDS = ['Shipper', 'ShipperAddress', 'Consignee', 'ConsigneeAddress', 'Airwaybill', 'BookingDate', 'Items'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

type Row = Record<string, unknown>;
type Dated = CarrierEvent & { description: string };

/** An AP Cargo waybill number; anything else is not one AP Cargo issues. */
export function normalizeApCargoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AP Cargo waybill numbers have eight digits');
  return number;
}

const isEmptyRecord = (value: unknown): boolean => isRecord(value) && RECORD_FIELDS.every((field) => value[field] === null);

function parseBody(body: unknown): unknown {
  try {
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return undefined;
  }
}

/**
 * The shipment record of a reply. A found waybill comes as the record itself.
 * A lookup the tracker could not answer comes wrapped, `success` false with a
 * status code and the record as JSON text: 404 around an empty record is its
 * answer for a number it does not hold.
 */
export function apCargoRecord(payload: unknown): Row {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'AP Cargo returned a reply that is not a record');
  if (!('success' in payload) && !('statusCode' in payload)) return payload;
  if (payload.success !== false || typeof payload.statusCode !== 'number') {
    throw new SchemaError(PROVIDER, 'AP Cargo returned an unexpected envelope');
  }
  const status = payload.statusCode;
  if (status === 404) {
    if (isEmptyRecord(parseBody(payload.body))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'AP Cargo returned an unexpected 404 answer', { status });
  }
  if (status === 429) throw new RateLimitedError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'AP Cargo could not answer the lookup', { status });
}

/** A row's clock: the branch's wall clock, a bare date at midnight, which marks a row without a time of day, else the text as it came. */
function rowClock(row: Row): { local_time: string } | { provider_time_text: string } {
  const raw = clean(row.DateTime, 64);
  const match = CLOCK.exec(raw);
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  if (match && DateTime.fromISO(wall, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall) {
    return { local_time: match[2] === '00:00:00' ? match[1]! : wall };
  }
  const text = raw || clean(row.DateString, 64);
  if (!text) throw new SchemaError(PROVIDER, 'AP Cargo returned a row without a date');
  return { provider_time_text: text };
}

function rowEvent(row: unknown): Dated {
  if (!isRecord(row) || typeof row.Status !== 'string' || (row.Location !== null && row.Location !== undefined && typeof row.Location !== 'string')) {
    throw new SchemaError(PROVIDER, 'AP Cargo returned an invalid row');
  }
  const description = clean(row.Status, 300);
  if (!description) throw new SchemaError(PROVIDER, 'AP Cargo returned a row without a status');
  const location = clean(row.Location, 120);
  const staged = apCargoStage(description);
  return {
    ...rowClock(row), ...(location ? { location } : {}), description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The rows of a record's `Items`, each a day with its `DeliveryStatus` rows, as they come: newest first. */
function recordEvents(items: unknown[]): Dated[] {
  const rows = items.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.DeliveryStatus)) throw new SchemaError(PROVIDER, 'AP Cargo returned an invalid day');
    return item.DeliveryStatus as unknown[];
  });
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'AP Cargo returned an oversized history');
  return rows.map(rowEvent);
}

/**
 * The delivery the older tracker records for the number, when its reply
 * names the number. It dates a delivery by its day alone.
 */
function legacyDeliveries(legacy: unknown, number: string): Dated[] {
  if (!isRecord(legacy) || clean(legacy.Airwaybill, 64) !== number || !Array.isArray(legacy.Items)) return [];
  try {
    return recordEvents(legacy.Items).filter((event) => event.stage === 'delivered' && event.local_time);
  } catch {
    return [];
  }
}

// A date-only row comes after the scans of its day; a row without a readable clock last.
const sortKey = (event: CarrierEvent): string => !event.local_time ? ''
  : event.local_time.length === 10 ? `${event.local_time}T24` : event.local_time;
const day = (event: CarrierEvent | undefined): string => event?.local_time?.slice(0, 10) ?? '';

/** Names as the tracker writes them, surname and given names in either order around a comma. */
const name = (value: unknown): string => clean(value, 120).replace(/\s+,/g, ',').replace(/^,\s*|,$/g, '');

/**
 * The reply of the tracker's `waybill-tracking` lookup for one waybill. The
 * record names the shipment by an internal code, never by the number asked:
 * the lookup matches whole numbers only, and the adapter sends whole numbers,
 * so the request ties the reply to the number. `legacy` is the older
 * tracker's reply for the same number, whose delivery fills in a history
 * that stops before it.
 */
export function parseApCargo(payload: unknown, requested: string, legacy: unknown = null): CarrierResult {
  const number = normalizeApCargoNumber(requested);
  const record = apCargoRecord(payload);
  if (!clean(record.Airwaybill, 64)) throw new SchemaError(PROVIDER, 'AP Cargo returned a record without its waybill');
  const items = record.Items ?? [];
  if (!Array.isArray(items)) throw new SchemaError(PROVIDER, 'AP Cargo returned a record without a history');

  const events = recordEvents(items);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The tracker can stop at the delivery round while the older one records the delivery. Only
  // a delivery on or after the day of the tracker's newest row is kept.
  if (!events.some((event) => event.stage === 'delivered')) {
    const since = day(events.reduce((latest, event) => sortKey(event) > sortKey(latest) ? event : latest));
    if (since) events.push(...legacyDeliveries(legacy, number).filter((event) => day(event) >= since));
  }
  // Rows come newest first: the stable sort keeps rows of the same clock in the tracker's order.
  events.sort((left, right) => {
    const [later, earlier] = [sortKey(right), sortKey(left)];
    return later > earlier ? 1 : later < earlier ? -1 : 0;
  });

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const sender = name(record.Shipper);
  const receiver = name(record.Consignee);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: events.find((event) => event.local_time)?.local_time ?? null,
    expected_delivery: null,
    ...(sender ? { sender_name: sender } : {}),
    ...(receiver ? { receiver_name: receiver } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
