import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { pargoStage } from './status.js';

export const PROVIDER = 'pargo';
/** The tracker's host: it serves the page and the lookup the page makes. */
export const PARGO_ORIGIN = 'https://track.pargo.co.za';
// An order with its scans and addresses is a few kilobytes.
export const PARGO_MAX_BYTES = 256 * 1024;

// Pargo's own codes are PAR and ten digits, but the tracker also files orders under a shop's
// waybill, letters and digits, so the adapter takes any such code and the reply must repeat it.
const NUMBER = /^[A-Z0-9]{6,40}$/;
const CODE = /^\d{1,3}(?:\.\d{1,6}){2,5}$/;
const MAX_SCANS = 300;
// The flows whose parcel goes from a shop's warehouse, so that the order's owner is its sender.
const FROM_WAREHOUSE = new Set(['W2P', 'W2D']);

/** A code for Pargo's tracker: letters and digits, in capitals. */
export function normalizePargoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Pargo tracking code');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max = 200): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) return invalid('Pargo returned an invalid field');
  return value.replace(/\s+/g, ' ').trim() || undefined;
};
const instant = (value: unknown, what: string) => {
  const parsed = explicitOffsetTime(value);
  if (!parsed || parsed.timestamp < Date.UTC(2001, 0, 1)) return invalid(`Pargo returned an invalid ${what}`);
  return parsed;
};
const eventCode = (value: unknown): string => {
  const code = text(value, 40);
  return code && CODE.test(code) ? code : invalid('Pargo returned an invalid event code');
};

/** A scan's or the order's stage from its code and wording, else from the shared wording rules. */
function stageOf(code: string, wording: string): { stage: Stage; stage_source: string } | undefined {
  const mapped = pargoStage(code, wording);
  if (mapped) return { stage: mapped, stage_source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, stage_source: worded.source };
}

/**
 * The tracker's refusal: a lookup of a reference it holds no order for, named whole in the
 * error, is not found; any other error is a reply the adapter cannot read.
 */
function refusal(errors: unknown[], number: string): never {
  const [error] = errors;
  if (errors.length === 1 && isRecord(error) && error.title === 'validation_error' && typeof error.detail === 'string') {
    const reference = /^Cannot find an order with reference: (\S+)$/.exec(error.detail.trim())?.[1];
    if (reference !== undefined && reference.toUpperCase() === number) {
      throw new NotFoundError(PROVIDER, 'Pargo has no order under this reference');
    }
    if (reference !== undefined) throw new IndeterminateError(PROVIDER, 'Pargo answered for another reference');
  }
  return invalid('Pargo refused the lookup with an unknown error');
}

/** The pickup point of an order bound for one: its name, then its address lines. */
function pickupPoint(addresses: unknown): { name: string; lines: string[]; town?: string } | undefined {
  if (!Array.isArray(addresses)) return undefined;
  const points = addresses.filter((address) => isRecord(address) && address.type === 'pickupPoint') as Record<string, unknown>[];
  if (points.length !== 1) return undefined;
  const point = points[0]!;
  const name = text(point.businessName, 160);
  if (!name) return undefined;
  const town = text(point.city, 80);
  const place = [town, text(point.postalCode, 12)].filter(Boolean).join(' ');
  const lines = [text(point.address1, 160), text(point.address2, 160), text(point.suburb, 80), place].filter((line): line is string => !!line);
  return { name, lines, ...(town ? { town } : {}) };
}

/**
 * Reads the tracker's answer for one code: the order, its scans and its current status. Scan
 * times are instants with their offset. The recipient's address, the shop's support contacts,
 * the courier and the progress steps stay behind.
 */
export function parsePargo(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) return invalid('Pargo returned an unreadable reply');
  if (Array.isArray(payload.errors) && payload.errors.length) refusal(payload.errors, number);
  if (payload.success !== true || !isRecord(payload.data) || !isRecord(payload.data.orderData)) {
    return invalid('Pargo returned a reply without an order');
  }
  const { data } = payload;
  const order = data.orderData as Record<string, unknown>;
  const code = text(order.trackingCode, 64);
  if (!code) return invalid('Pargo returned an order without its tracking code');
  if (normalizeTrackingNumber(code) !== number) throw new IndeterminateError(PROVIDER, 'Pargo answered for another order');
  const type = text(order.orderType, 40);

  const rows = data.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) return invalid('Pargo returned an invalid history');
  const scans = rows.map((row, index) => {
    if (!isRecord(row)) return invalid('Pargo returned an invalid scan');
    const provider_code = eventCode(row.code);
    const description = text(row.title) ?? invalid('Pargo returned a scan without its title');
    const time = instant(row.date, 'scan time');
    if (row.seq !== undefined && !Number.isSafeInteger(row.seq)) return invalid('Pargo returned an invalid scan order');
    const event: CarrierEvent = { time: time.iso, description, provider_code, ...stageOf(provider_code, description) };
    return { event, at: time.timestamp, seq: typeof row.seq === 'number' ? row.seq : index };
  });
  // The tracker lists its scans by their order, oldest first; scans of one instant keep it, reversed.
  const events = scans.sort((left, right) => right.at - left.at || right.seq - left.seq).map(({ event }) => event);

  const status = isRecord(data.currentStatus) ? data.currentStatus : undefined;
  if (data.currentStatus != null && !status) return invalid('Pargo returned an invalid current status');
  const statusCode = status ? eventCode(status.code) : undefined;
  const statusTitle = status ? text(status.title) : undefined;
  const updated = status?.updatedAt != null ? instant(status.updatedAt, 'status time') : undefined;
  if (!statusCode && !events.length) return invalid('Pargo returned an order without a status or scans');
  const current = statusCode ? stageOf(statusCode, statusTitle ?? '') : events[0]?.stage
    ? { stage: events[0].stage as Stage, stage_source: events[0].stage_source! } : undefined;
  const stage = current?.stage;

  const deliveredScan = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const deliveredAt = stage === 'delivered' ? deliveredScan?.time ?? updated?.iso : undefined;
  // Only an order sent to a pickup point names the point it waits at, once it waits there or was
  // collected from it; its arrival and collection scans take the point as their place.
  const point = type === 'W2P' ? pickupPoint(data.addresses) : undefined;
  const collected = deliveredScan !== undefined && lastMovement(events.slice(events.indexOf(deliveredScan) + 1)) === 'ready_for_pickup';
  const atPoint = point && (stage === 'ready_for_pickup' || collected) ? point : undefined;
  if (atPoint) {
    const location = [atPoint.name, atPoint.town].filter(Boolean).join(', ');
    for (const event of events) if (event.stage === 'ready_for_pickup' || event === deliveredScan) event.location = location;
  }
  const sender = type && FROM_WAREHOUSE.has(type) && isRecord(order.owner) ? text(order.owner.name, 120) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: statusTitle ?? events[0]?.description ?? null,
    ...(events.length ? {} : { provider_code: statusCode!, summary_only: true }),
    last_update: events[0]?.time ?? updated?.iso ?? null,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(atPoint ? { pickup_point: [atPoint.name, ...atPoint.lines].join('\n') } : {}),
    ...(sender ? { sender_name: sender } : {}),
    events,
  };
}
