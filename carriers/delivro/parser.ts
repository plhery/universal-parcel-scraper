import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { delivroOrder, delivroStage, statusMap } from './status.js';

export const PROVIDER = 'Délivro';
export const CARRIER = 'delivro';
// An order with five checkpoints is about 3 kB.
export const DELIVRO_MAX_BYTES = 256 * 1024;

// Délivro's order ids are DEL and digits; the tracker looks up any order id of the account.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// "2026-06-30T17:44:19.839656-04:00": an instant with the offset it was written at, to a fraction of a second.
const INSTANT = /^(\d{4})-\d{2}-\d{2}T(\d{2}):\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
// The order status, which the reply writes in digits; 91 is a cancelled order.
const CODE = /^\d{1,3}$/;
const CANCELLED = '91';
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|The request is blocked/i;
const MAX_SCANS = 300;

/** A number for Délivro's tracker: letters and digits, in capitals, with at least one digit. */
export function normalizeDelivroNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Délivro looks orders up by 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isDelivroBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('Délivro returned an invalid field');
  return clean(value, max);
}

/**
 * An instant as the reply writes it, with the offset it states, to the second; null when it is not
 * one. Date libraries accept hour 24, so the hour is checked here.
 */
function instant(value: unknown): { iso: string; timestamp: number } | null {
  const parts = typeof value === 'string' ? INSTANT.exec(value) : null;
  if (!parts || Number(parts[1]) < 2000 || Number(parts[2]) > 23) return null;
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  if (!parsed.isValid) return null;
  return { iso: parsed.startOf('second').toISO({ suppressMilliseconds: true }), timestamp: parsed.toMillis() };
}

/** The order status code in digits, or empty when the reply gives none. */
function statusCode(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1000) return String(value);
  if (typeof value === 'string' && CODE.test(value)) return String(Number(value));
  return invalid('Délivro returned an invalid order status');
}

interface Scan {
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

/**
 * One checkpoint: its instant, its wording and whether the tracker flags it as an interruption.
 * The note under it and the support line beside an interruption are not read.
 */
function scan(row: unknown, index: number): Scan {
  if (!isRecord(row)) return invalid('Délivro returned an invalid checkpoint');
  const description = text(row.description, 300) || invalid('Délivro returned a checkpoint without its wording');
  const time = instant(row.timestamp) ?? invalid('Délivro returned an invalid checkpoint time');
  if (row.interruption !== undefined && row.interruption !== null && typeof row.interruption !== 'boolean') {
    return invalid('Délivro returned an invalid interruption flag');
  }
  const staged = delivroStage(description, row.interruption === true);
  return {
    event: { time: time.iso, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
    timestamp: time.timestamp,
    index,
  };
}

/** Newest first, as the tracker lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(scans: Scan[]): CarrierEvent[] {
  const ordered = scans.length > 1 && scans[0]!.timestamp < scans.at(-1)!.timestamp
    ? scans.reverse().map((item, index) => ({ ...item, index })) : scans;
  return ordered.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).map(({ event }) => event);
}

type Estimate = Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from' | 'unread_estimates'>;

/**
 * The estimate the page shows for an order not yet delivered: its ETA when the order is on a
 * route, else the drop-off window. A field that is not an instant is named as unread.
 */
function estimate(payload: Record<string, unknown>): Estimate {
  if (payload.eta !== null && payload.eta !== undefined) {
    const eta = instant(payload.eta);
    return eta ? { expected_delivery: eta.iso } : { expected_delivery: null, ...unreadEstimates({ eta: payload.eta }) };
  }
  if ((payload.dropoffFromTime ?? null) === null && (payload.dropoffToTime ?? null) === null) return { expected_delivery: null };
  const from = instant(payload.dropoffFromTime);
  const to = instant(payload.dropoffToTime);
  if (!from || !to || from.timestamp > to.timestamp) {
    return { expected_delivery: null, ...unreadEstimates({ dropoffFromTime: payload.dropoffFromTime, dropoffToTime: payload.dropoffToTime }) };
  }
  return { expected_delivery: to.iso, ...(from.timestamp < to.timestamp ? { expected_delivery_from: from.iso } : {}) };
}

/**
 * The reply of `delivro.dsapp.io/api/v1/orders/tracking/{number}`, the lookup Délivro's Dispatch
 * Science tracking page makes. It repeats the order id, gives the order's status code, the drop-off
 * window or an ETA, the delivery's instant, and the checkpoints newest first, each with an instant
 * and its offset, a wording and the order's status code when it was written. Instants keep the
 * offset the reply states.
 *
 * The pickup and drop-off towns, the drop-off and driver positions on the map, the signature
 * flags, the checkpoints' notes, the support line and the branding are never read.
 */
export function parseDelivro(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDelivroNumber(raw);
  if (!isRecord(payload) || typeof payload.orderId !== 'string') return invalid('Délivro returned an unexpected reply');
  // The reply repeats the order id, in capitals whatever case was asked.
  if (normalizeTrackingNumber(payload.orderId).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Délivro answered for another order');
  }
  if (payload.history !== undefined && payload.history !== null && !Array.isArray(payload.history)) {
    return invalid('Délivro returned an invalid history');
  }
  const rows = (payload.history ?? []) as unknown[];
  if (rows.length > MAX_SCANS) return invalid('Délivro returned too many checkpoints');
  const events = newestFirst(rows.map(scan));

  const code = statusCode(payload.status);
  const order = code ? delivroOrder(code) : undefined;
  const deliveredAt = payload.statusDeliveredDate === null || payload.statusDeliveredDate === undefined
    ? undefined : instant(payload.statusDeliveredDate) ?? invalid('Délivro returned an invalid delivery time');
  // The page shows an estimate only for an order not yet delivered; a cancelled order has none.
  const estimated: Estimate = deliveredAt || code === CANCELLED ? { expected_delivery: null } : estimate(payload);
  const delivered = deliveredAt ? { delivered_at: deliveredAt.iso } : {};

  const newest = events[0];
  if (!newest) {
    // An order without checkpoints stands on its status code, when the page names it.
    if (!order) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(order.stage), current_stage: order.stage, current_stage_source: 'carrier_map',
      provider_code: code, last_status_text: order.label, last_update: null, ...estimated, ...delivered,
      summary_only: true, events: [],
    };
  }
  // The newest staged checkpoint leads; the order's status code stands in when none does.
  const lead = leadingScan(events, statusMap);
  const stage = (lead?.stage ?? order?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage ? lead.stage_source! : 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...estimated,
    ...delivered,
    events,
  };
}

/**
 * Whether a reply is the tracker's answer, with HTTP 404, for an order id it holds nothing for:
 * the framework's bare problem document, without an order.
 */
export function isDelivroNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.status === 404 && payload.title === 'Not Found'
    && payload.orderId === undefined && payload.detail === undefined && payload.errors === undefined;
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function delivroJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isDelivroBlocked(body)) throw new ChallengeError(PROVIDER, 'Délivro answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Délivro returned a reply that is not JSON', { cause });
  }
}
