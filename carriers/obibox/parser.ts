import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { windowEstimate, type WindowEstimate } from '../../core/result/window.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { obiboxMappedStage, obiboxStage, statusMap } from './status.js';

export const PROVIDER = 'Obibox';
export const CARRIER = 'obibox';
// A delivered parcel with five scans is about 4 kB.
export const OBIBOX_MAX_BYTES = 256 * 1024;

// The tracker's numbers, as the tracking links carry them: letters, digits and the underscore of older numbers.
const NUMBER = /^[A-Z0-9_]{8,40}$/;
const CODE = /^[a-z0-9_]{2,60}$/;
// Keys of the reply beside its milestones, as the tracking page's script sets them apart.
const NOT_MILESTONES = new Set(['tracking_statuses', 'hide_pickup_statuses', 'shipment_info']);
const FINAL_STAGES = new Set<Stage>(['delivered', 'returned']);
// The statuses the page shows a delivery window for; the ready ones only in a reply that hides the collection's steps.
const WINDOW_STATUSES = new Set(['pickup_confirmed', 'on_delivery']);
const READY_STATUSES = new Set(['shipment_ready', 'shipment_ready_engaged', 'shipment_ready_for_delivery', 'engaged', 'on_route']);
// "2026-05-13 09:45:00": the page shows its day alone.
const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|awswaf/i;
const MAX_SCANS = 300;

/** A number for Obibox's tracker: letters, digits and underscores, in capitals. */
export function normalizeObiboxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Obibox looks parcels up by 8 to 40 letters, digits and underscores');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isObiboxBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** Whether a reply is the tracker's answer for a number it holds no parcel under, which it sends with HTTP 404. */
export function isObiboxNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.code === 12001 && payload.message === 'No Parcel Found';
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('Obibox returned an invalid field');
  return clean(value, max);
}

/** The page's own words for a code it does not word otherwise: "on_route" reads "On Route". */
const spelled = (code: string): string => code.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

/**
 * The milestones of the reply, in its order, each the record of one step with a copy of the
 * shipment as it now stands, and the shipment the reply gives without a milestone.
 */
function shipments(payload: Record<string, unknown>): { milestones: [string, Record<string, unknown>][]; records: Record<string, unknown>[] } {
  const milestones = Object.entries(payload)
    .filter((entry): entry is [string, Record<string, unknown>] => !NOT_MILESTONES.has(entry[0]) && isRecord(entry[1]) && isRecord(entry[1].shipment));
  const records = milestones.map(([, milestone]) => milestone.shipment as Record<string, unknown>);
  if (payload.shipment_info !== undefined && payload.shipment_info !== null) {
    if (!isRecord(payload.shipment_info)) return invalid('Obibox returned an invalid shipment');
    records.push(payload.shipment_info);
  }
  return { milestones, records };
}

function scan(row: unknown, index: number): { index: number; at: number; event: CarrierEvent } {
  if (!isRecord(row)) return invalid('Obibox returned an invalid scan');
  const code = text(row.status, 60);
  if (!CODE.test(code)) return invalid('Obibox returned a scan without its status code');
  const time = explicitOffsetTime(row.timestamp);
  if (!time || time.timestamp < Date.UTC(2015, 0, 1)) return invalid('Obibox returned an invalid scan time');
  const description = text(row.description, 300) || spelled(code);
  const staged = obiboxStage(code, description);
  // The scan's place is not read: the page puts the recipient's address there for a delivery's steps.
  return { index, at: time.timestamp, event: {
    time: time.iso, description, provider_code: code, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** Newest first; scans of one instant keep their order in the reply, which lists the oldest first. */
function newestFirst(rows: { index: number; at: number; event: CarrierEvent }[]): CarrierEvent[] {
  const oldestFirst = rows.length < 2 || rows[0]!.at <= rows.at(-1)!.at;
  return rows.sort((a, b) => b.at - a.at || (oldestFirst ? b.index - a.index : a.index - b.index)).map(({ event }) => event);
}

/**
 * The estimate the tracking page shows. A parcel collected or out for delivery, or one still
 * ready in a reply that hides the collection's steps, has the window of the delivery's own milestone,
 * else of the current one, else of the collection: two instants with their offsets. Otherwise
 * the page shows the shipment's delivery date as a day.
 */
function estimate(payload: Record<string, unknown>, current: string | undefined, shipment: Record<string, unknown>): WindowEstimate {
  const status = text(shipment.status, 60);
  if (WINDOW_STATUSES.has(status) || (payload.hide_pickup_statuses === true && READY_STATUSES.has(status))) {
    for (const key of ['on_delivery', current, 'pickup_confirmed']) {
      const milestone = key === undefined ? undefined : payload[key];
      const tracking = isRecord(milestone) && isRecord(milestone.tracking) ? milestone.tracking : undefined;
      if (!tracking?.eta_start || !tracking.eta_end) continue;
      const window = windowEstimate(tracking.eta_start, tracking.eta_end);
      if (window.expected_delivery) return window;
    }
  }
  const day = DAY.exec(text(shipment.delivery_date, 40));
  return { expected_delivery: day && calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) || null };
}

/**
 * The reply of `api.obibox.io/shipment_tracking/public/shipment_tracking` for one number, the
 * lookup Obibox's tracking page makes. It holds one milestone per step the parcel reached, each
 * with a copy of the shipment that repeats the number, and the scans, oldest first, each with
 * its status code, an English description and an instant in UTC. The collection's milestone
 * gives the delivery window.
 *
 * The recipient's name and address, the shop's address, the delivery instructions, the order
 * number, the map positions and the driver's position are never read.
 */
export function parseObibox(payload: unknown, raw: string): CarrierResult {
  const number = normalizeObiboxNumber(raw);
  if (isObiboxNotFound(payload)) throw new NotFoundError(PROVIDER, 'Obibox has no parcel under this number');
  if (!isRecord(payload)) return invalid('Obibox returned an unexpected reply');
  const { milestones, records } = shipments(payload);
  if (!records.length) return invalid('Obibox returned a reply without its shipment');
  // Every copy of the shipment repeats the number it was found under.
  for (const record of records) {
    if (typeof record.tracking_number !== 'string') return invalid('Obibox returned a shipment without its number');
    if (normalizeTrackingNumber(record.tracking_number).toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'Obibox answered for another number');
    }
  }
  const rows = payload.tracking_statuses ?? [];
  if (!Array.isArray(rows)) return invalid('Obibox returned an invalid history');
  if (rows.length > MAX_SCANS) return invalid('Obibox returned too many scans');
  const events = newestFirst(rows.map(scan));

  // The page reads the last milestone as the current one; its copy of the shipment holds the current status.
  const [current, milestone] = milestones.at(-1) ?? [];
  const shipment = (milestone?.shipment ?? records[0]) as Record<string, unknown>;
  const sender = text(shipment.shipper_name, 120);
  const newest = events[0];
  if (!newest) {
    // Without scans, the current status stands alone when the map knows it.
    const code = text(shipment.status, 60);
    const stage = CODE.test(code) ? obiboxMappedStage(code) : undefined;
    if (!stage) throw new NoHistoryError(PROVIDER, 'Obibox lists the shipment without its scans', { reason: 'listed' });
    return {
      status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map', provider_code: code,
      last_status_text: spelled(code), last_update: null, expected_delivery: null,
      ...(sender ? { sender_name: sender } : {}), summary_only: true, events: [],
    };
  }

  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const open = !stage || !FINAL_STAGES.has(stage);
  const delivery = isRecord(payload.on_delivery) && isRecord(payload.on_delivery.tracking) ? payload.on_delivery.tracking : {};
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(open ? estimate(payload, current, shipment) : { expected_delivery: null }),
    // The driver's time and distance away while the parcel is out, which the page counts from the moment it asks.
    ...(open ? unreadEstimates({ 'on_delivery.tracking.eta': delivery.eta }) : {}),
    ...(sender ? { sender_name: sender } : {}),
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function obiboxJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isObiboxBlocked(body)) throw new ChallengeError(PROVIDER, 'Obibox answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Obibox returned a reply that is not JSON', { cause });
  }
}
