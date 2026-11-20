import { ChallengeError, IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bobGoRequestNumber } from './number.js';
import { bobGoMappedStage, bobGoStage } from './status.js';

export const PROVIDER = 'Bob Go';
export const BOB_GO_MAX_BYTES = 1024 * 1024;
const MAX_SHIPMENTS = 20;
const MAX_CHECKPOINTS = 500;
const MAX_EVENTS = 100;
// "2025-10-10 12:30:00+02:00": a clock with its offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const STATE = /^[a-z]{1,30}(?:-[a-z]{1,30}){0,5}$/;
const MISSING = /^Shipment with reference (\S{1,64}) not found\.?$/;
// A CDN's or firewall's page in place of the service's reply.
const BLOCKED = /_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

/** A checkpoint's instant, to the second, with the offset Bob Go gives. */
function instant(value: unknown): { time: string; timestamp: number } {
  const parts = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const parsed = parts ? explicitOffsetTime(`${parts[1]}T${parts[2]}${parts[3]}`) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Bob Go returned an invalid checkpoint time');
  return { time: parsed.iso.replace(/\.\d+(?=[+-]|Z$)/, ''), timestamp: parsed.timestamp };
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bob Go returned an invalid ${key}`);
  return clean(value, maxLength);
}

function state(row: Record<string, unknown>): string {
  const value = text(row, 'status', 80);
  if (!STATE.test(value)) throw new SchemaError(PROVIDER, 'Bob Go returned an invalid state');
  return value;
}

/**
 * Whether the body of Bob Go's HTTP 500 says it holds no shipment under this
 * very reference: `{"message": "<JSON>"}`, the inner JSON's message naming it.
 */
export function bobGoMissing(body: string, raw: string): boolean {
  const number = bobGoRequestNumber(raw);
  try {
    const outer: unknown = JSON.parse(body);
    if (!isRecord(outer) || typeof outer.message !== 'string') return false;
    const inner: unknown = JSON.parse(outer.message);
    if (!isRecord(inner) || inner.success !== false || !isRecord(inner.data) || typeof inner.data.message !== 'string') return false;
    return MISSING.exec(inner.data.message.trim())?.[1]?.toUpperCase() === number;
  } catch {
    return false;
  }
}

interface Checkpoint { event: CarrierEvent; timestamp: number; order: number }

function checkpointOf(row: unknown, order: number): Checkpoint {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bob Go returned an invalid checkpoint');
  const code = state(row);
  const label = text(row, 'status_friendly', 80);
  const message = text(row, 'message', 300);
  // The tracker shows the state's label, then the courier's message under it.
  const description = label && message ? `${label}: ${message}` : label || message;
  if (!description) throw new SchemaError(PROVIDER, 'Bob Go returned a checkpoint without wording');
  const { time, timestamp } = instant(row.time);
  const staged = bobGoStage(code, label || message);
  return { order, timestamp, event: { time, description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } };
}

/** The first of the delivered checkpoints that end the history, past any checkpoint without a stage. */
function deliveryTime(events: readonly CarrierEvent[]): string | null {
  let at: string | null = null;
  for (const event of events) {
    if (!event.stage) continue;
    if (event.stage !== 'delivered') break;
    at = event.time!;
  }
  return at;
}

/**
 * The reply of `GET api.bobgo.co.za/tracking?tracking_reference=…`, which
 * Bob Go's tracker makes: a list of shipments, each with its state, the
 * merchant, the courier and service, and its checkpoints with their offsets.
 * Only the shipment filed under the whole reference asked is read. A pickup
 * or delivery PIN, the courier's phone and the logos are not read; neither
 * is the checkpoint's location, the courier's hub code.
 */
export function parseBobGo(body: string, raw: string): CarrierResult {
  const number = bobGoRequestNumber(raw);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bob Go answered with a browser check');
    throw new SchemaError(PROVIDER, 'Bob Go returned an invalid tracking reply');
  }
  if (!Array.isArray(payload) || !payload.length || payload.length > MAX_SHIPMENTS) {
    throw new SchemaError(PROVIDER, 'Bob Go returned an unexpected tracking reply');
  }
  const own = payload.filter((entry) => isRecord(entry) && text(entry, 'shipment_tracking_reference', 64).toUpperCase() === number);
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Bob Go answered for another shipment');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'Bob Go lists several shipments under the reference');
  const shipment = own[0] as Record<string, unknown>;
  if (!Array.isArray(shipment.checkpoints)) throw new SchemaError(PROVIDER, 'Bob Go returned a shipment without checkpoints');
  if (shipment.checkpoints.length > MAX_CHECKPOINTS) throw new SchemaError(PROVIDER, 'Bob Go returned an oversized history');
  const current = state(shipment);
  if (!shipment.checkpoints.length) {
    throw new NoHistoryError(PROVIDER, 'Bob Go lists the shipment but holds no checkpoint yet', { reason: 'listed' });
  }

  const seen = new Set<string>();
  const listed = shipment.checkpoints.map(checkpointOf).filter(({ event }) => {
    // A checkpoint the reply lists twice is kept once.
    const identity = JSON.stringify([event.time, event.description]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  // Newest first, as the tracker lists them; checkpoints of the same second keep the reply's order.
  listed.sort((left, right) => right.timestamp - left.timestamp || left.order - right.order);
  const events = listed.map(({ event }) => event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The shipment's own state, when the map knows it, is Bob Go's word on where the parcel is.
  const stated = bobGoMappedStage(current);
  const stage = (stated ?? scanned?.stage) as Stage | undefined;
  const byState = stated !== undefined && scanned?.stage !== stated;
  const label = text(shipment, 'status_friendly', 80);
  const deliveredAt = stage === 'delivered' ? deliveryTime(events) : null;
  const merchant = text(shipment, 'merchant_name', 120);
  const service = text(shipment, 'service_level', 120);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: stated ? 'carrier_map' : scanned!.stage_source! } : {}),
    last_status_text: byState && label ? label : newest.description!,
    ...(byState ? { provider_code: current } : {}),
    last_update: newest.time!,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(merchant ? { sender_name: merchant } : {}),
    ...(service ? { service_name: service } : {}),
    ...unreadEstimates({
      shipment_estimated_delivery_date_from: shipment.shipment_estimated_delivery_date_from,
      shipment_estimated_delivery_date_to: shipment.shipment_estimated_delivery_date_to,
      shipment_earliest_delivery_date: shipment.shipment_earliest_delivery_date,
    }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
