import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { warpStage, warpStatusLabel } from './status.js';

export const PROVIDER = 'warp';
// An order with its shipments, stops and events is a few kilobytes.
export const WARP_MAX_BYTES = 1024 * 1024;

// WARP's own numbers: S for a shipment, P for the order holding it, then a serial and four
// digits for the year and week, as S-12345-2639. Both hyphens may be left out.
const NUMBER = /^([SP])(?:-(\d{3,9})-|(\d{3,9}))(\d{4})$/;
const CODE = /^[A-Za-z]{2,40}$/;
const STATE = /^[A-Z]{2}$/;
const MAX_SHIPMENTS = 200;
const MAX_EVENTS = 500;
// The shipment statuses the tracking page headlines whatever the events say: the shipment's end.
const SETTLED = new Set(['complete', 'canceled', 'removed', 'disposed', 'returned', 'lost']);
const ENDED: ReadonlySet<string> = new Set<Stage>(['delivered', 'exception', 'returned']);
const PROGRESS: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];

/** A WARP shipment or order number, with its hyphens as WARP writes it. */
export function normalizeWarpNumber(raw: string): string {
  const parts = NUMBER.exec(typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/\s+/g, '') : '');
  if (!parts) throw new InvalidInputError(PROVIDER, 'Enter the WARP shipment or order number, as S-12345-2639');
  return `${parts[1]}-${parts[2] ?? parts[3]}-${parts[4]}`;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const same = (value: unknown, number: string) => typeof value === 'string' && normalizeTrackingNumber(value) === normalizeTrackingNumber(number);

interface Shipment { id: string; proNumber: string; status: string; etas: unknown[] }

function shipmentOf(value: unknown): Shipment {
  if (!isRecord(value)) return invalid('WARP returned an invalid shipment');
  const id = clean(value.id, 80);
  const status = clean(value.status, 40);
  if (!id || typeof value.proNumber !== 'string' || (status && !CODE.test(status))) return invalid('WARP returned a shipment without its id or status');
  return { id, proNumber: value.proNumber, status, etas: Array.isArray(value.etas) ? value.etas : [] };
}

/** "Haverhill, MA": the town and state an event's address names. */
function placeOf(address: unknown): string | undefined {
  if (!isRecord(address)) return undefined;
  const city = clean(address.city, 60);
  const state = clean(address.state, 4);
  if (!city) return undefined;
  return STATE.test(state) ? `${city}, ${state}` : city;
}

/** The delivery window WARP gives the drop-off, as instants. */
function windowOf(shipment: Shipment): { from: string; to: string } | undefined {
  for (const eta of shipment.etas) {
    if (!isRecord(eta) || eta.destinationType !== 'DROPOFF' || !isRecord(eta.window)) continue;
    const from = explicitOffsetTime(eta.window.from);
    const to = explicitOffsetTime(eta.window.to);
    if (from && to && from.timestamp <= to.timestamp) return { from: from.iso, to: to.iso };
  }
  return undefined;
}

/**
 * Where the shipment stands, as the tracking page headlines it: a settled shipment, or one whose
 * status is off the way to delivery, by its status; otherwise by the further along of its status
 * and its newest staged event, and by that event when it is off the way.
 */
function currentStage(status: string, event: Stage | undefined): Stage | undefined {
  const coded = status ? warpStage(status) ?? undefined : undefined;
  if (!coded) return event;
  if (!event || SETTLED.has(status) || !PROGRESS.includes(coded)) return coded;
  if (!PROGRESS.includes(event)) return event;
  return PROGRESS.indexOf(event) > PROGRESS.indexOf(coded) ? event : coded;
}

/**
 * Reads WARP's tracking reply for one shipment, or for an order holding one. Who ordered,
 * the stops' names, streets, references, coordinates and proofs of delivery stay behind; an
 * event keeps its town. Event times are instants.
 */
export function parseWarp(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.shipments) || !Array.isArray(payload.events) || !isRecord(payload.order)) {
    return invalid('WARP returned an unreadable reply');
  }
  if (payload.shipments.length > MAX_SHIPMENTS || payload.events.length > MAX_EVENTS) return invalid('WARP returned too large a reply');
  const shipments = payload.shipments.map(shipmentOf);
  const order = payload.order;
  // A shipment number names its shipment; an order number names its shipment only when it holds one.
  let shipment = shipments.find((candidate) => same(candidate.proNumber, number));
  if (!shipment && same(order.proNumber, number)) {
    if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'WARP lists several shipments under this order');
    shipment = shipments[0];
  }
  if (!shipment) throw new IndeterminateError(PROVIDER, 'WARP answered for another shipment');
  const owners = new Set([shipment.id, clean(order.id, 80)].filter(Boolean));

  const seen = new Set<string>();
  const events = payload.events.flatMap((value, index): { event: CarrierEvent; timestamp: number; index: number }[] => {
    if (!isRecord(value)) return invalid('WARP returned an invalid event');
    // The order's events name each of its shipments; another shipment's are not this one's.
    if (!owners.has(clean(value.object, 80))) return [];
    const time = epochMillisTime(value.ts);
    const code = clean(value.status, 40);
    if (!time || !CODE.test(code)) return invalid('WARP returned an event without its time or status');
    const description = clean(value.title, 200) || warpStatusLabel(code) || code;
    const key = JSON.stringify([time.iso, code]);
    if (seen.has(key)) return [];
    seen.add(key);
    const stage = warpStage(code, description);
    const location = placeOf(value.address);
    return [{ timestamp: time.timestamp, index, event: { time: time.iso, description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } }];
  })
    // The newest first; events at one instant keep the reply's order, which lists the earlier first.
    .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index)
    .map(({ event }) => event);

  const status = shipment.status;
  const stage = currentStage(status, events.find((event) => event.stage)?.stage as Stage | undefined);
  if (!events.length && !stage) throw new NoHistoryError(PROVIDER, 'WARP lists the shipment without events', { reason: 'listed' });
  const newest = events[0];
  const window = stage && ENDED.has(stage) ? undefined : windowOf(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(status ? { provider_code: status } : {}),
    last_status_text: newest?.description ?? (status ? warpStatusLabel(status) ?? status : null),
    last_update: newest?.time ?? null,
    expected_delivery: window?.to ?? null,
    ...(window ? { expected_delivery_from: window.from } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
