import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ddExpressStage, ddExpressWording, statusMap } from './status.js';

export const PROVIDER = 'dd-express';
// A parcel's reply is under a kilobyte; the lookup also answers a shipper's reference, which may list several parcels.
export const DD_EXPRESS_MAX_BYTES = 512 * 1024;

// The tracker takes any text and gives no layout; its tracking ids are digits. Letters and digits, with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// "2023-01-16T07:02:54.575Z": an instant, which the tracking page shows in its reader's zone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PARCELS = 50;
const MAX_STATUSES = 300;

/** A tracking id for DD Express's tracker. */
export function normalizeDdExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the DD Express tracking number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An instant the reply states, or null when it gives none. */
function instantOf(value: unknown, what: string): ParsedTime | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = clean(value, 40);
  return (INSTANT.test(raw) ? explicitOffsetTime(raw) : null) ?? invalid(`DD Express returned an unreadable ${what}`);
}

interface Scan { event: CarrierEvent & { time: string }; timestamp: number; order: number }

/**
 * One status. The tracking page dates it by `status_time` when the row has one, else by
 * `created_at`, when the row was written; the public sample's rows have no `status_time`.
 * Its photos stay behind.
 */
function scanOf(row: unknown, order: number, number: string): Scan {
  if (!isRecord(row)) return invalid('DD Express returned an invalid status');
  if (row.tracking_id !== undefined && normalizeTrackingNumber(cleanScalar(row.tracking_id, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'DD Express answered with another parcel’s status');
  }
  const description = ddExpressWording(clean(row.status, 300));
  if (!description) return invalid('DD Express returned a status without wording');
  const written = instantOf(row.created_at, 'status time') ?? invalid('DD Express returned a status without its time');
  const stated = instantOf(row.status_time, 'status time');
  const at = stated ?? written;
  const staged = ddExpressStage(description);
  return { timestamp: at.timestamp, order, event: {
    time: at.iso, description,
    ...(stated && stated.timestamp !== written.timestamp ? { written_at: written.iso } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The parcels of a reply of `GET /corporate/tracking/query?tracking_ids=<n>`:
 * `{"status":200,"message":"SUCCESS","data":[…]}`. An empty `data` is the lookup's answer for a
 * number it has no parcel under; any other status or message says nothing about the parcel.
 */
export function ddExpressParcels(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || typeof payload.status !== 'number') return invalid('DD Express returned an unreadable reply');
  if (payload.status !== 200 || payload.message !== 'SUCCESS') {
    throw new IndeterminateError(PROVIDER, `DD Express did not complete the lookup (status ${payload.status})`);
  }
  const { data } = payload;
  if (!Array.isArray(data) || data.length > MAX_PARCELS || !data.every(isRecord)) return invalid('DD Express returned an invalid parcel list');
  if (data.length === 0) throw new NotFoundError(PROVIDER, 'DD Express has no parcel under this number');
  return data;
}

/**
 * Reads the lookup's reply for one tracking id. The lookup finds a parcel by its tracking id or
 * by the shipper's reference, and the page lists both; shippers' references may repeat, so only
 * the parcel whose own tracking id is the number asked is read. Its statuses are instants and
 * name no place. The shipper's reference and the photos stay behind.
 */
export function parseDdExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDdExpressNumber(raw);
  const parcels = ddExpressParcels(payload).filter((parcel) => normalizeTrackingNumber(cleanScalar(parcel.tracking_id, 64)) === number);
  if (parcels.length !== 1) {
    throw new IndeterminateError(PROVIDER, parcels.length ? 'DD Express lists several parcels under this number' : 'DD Express answered for another parcel');
  }
  const rows = parcels[0]!.info ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_STATUSES) return invalid('DD Express returned an invalid status list');
  // The lookup lists statuses oldest first, and the page shows them the other way round.
  const events = rows.map((row, index) => scanOf(row, index, number))
    .sort((a, b) => b.timestamp - a.timestamp || b.order - a.order).map(({ event }) => event);
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'DD Express lists the parcel without a status', { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: lead!.time } : {}),
    events,
  };
}
