import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { rhenusDeStatus } from './status.js';

export const PROVIDER = 'rhenus-de';
// An order's reply is about a kilobyte, its tracking a few hundred bytes.
export const RHENUS_DE_MAX_BYTES = 256 * 1024;

// The retailer's order number, letters and digits once the facade has dropped spaces and dashes.
const NUMBER = /^[A-Z0-9]{4,40}$/;
const POSTCODE = /^\d{5}$/;
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The steps' clocks: an instant with its offset.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_STEPS = 50;
// An order past these stages expects no delivery.
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'exception', 'returned']);

/** The order number as the portal takes it. */
export function normalizeRhenusDeNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Rhenus Germany requires an order number of letters and digits');
  return number;
}

/** The delivery postcode, which every lookup needs. */
export function normalizeRhenusDePostcode(raw: string | null | undefined): string {
  const postcode = (raw ?? '').replace(/\s+/g, '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'postcode', 'Rhenus shows an order only with its delivery postcode');
  if (!POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'Rhenus Germany requires the five-digit delivery postcode');
  return postcode;
}

/** What the adapter keeps of an order: never its contact data. */
export interface RhenusDeOrder {
  readonly internalOrderId: string;
  readonly currentStatus: string;
  readonly windowFrom: unknown;
  readonly windowTo: unknown;
}

function json(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SchemaError(PROVIDER, `Rhenus answered its ${what} with something other than JSON`);
  }
}

/**
 * The portal's lookup of an order number and its delivery postcode. Its answer without an order is
 * the same for an unknown number and a wrong postcode, so it does not show the order is missing.
 */
export function readRhenusDeOrder(body: string, number: string): RhenusDeOrder {
  const data = json(body, 'order lookup');
  if (!isRecord(data) || typeof data.isOk !== 'boolean') throw new SchemaError(PROVIDER, 'Rhenus answered without its lookup result');
  if (!data.isOk) {
    if (data.order !== null) throw new SchemaError(PROVIDER, 'Rhenus answered a failed lookup with an order');
    throw new IndeterminateError(PROVIDER, 'Rhenus shows nothing for that order number and postcode', { reason: 'portal_not_found' });
  }
  const order = data.order;
  if (!isRecord(order)) throw new SchemaError(PROVIDER, 'Rhenus answered without the order');
  if (typeof order.orderNumber !== 'string' || normalizeTrackingNumber(order.orderNumber) !== number) {
    throw new IndeterminateError(PROVIDER, 'Rhenus answered for another order');
  }
  if (typeof order.internalOrderId !== 'string' || !ORDER_ID.test(order.internalOrderId)) {
    throw new SchemaError(PROVIDER, 'Rhenus answered without the order’s id');
  }
  if (typeof order.currentStatus !== 'string' || !order.currentStatus.trim()) {
    throw new SchemaError(PROVIDER, 'Rhenus answered without the order’s status');
  }
  return {
    internalOrderId: order.internalOrderId,
    currentStatus: order.currentStatus.trim(),
    windowFrom: order.deliveryTimeWindowFrom,
    windowTo: order.deliveryTimeWindowTo,
  };
}

/**
 * The order's tracking steps that took place, newest first. A step the portal marks done carries
 * its instant with an offset; steps still ahead come without one, or with another status, and are
 * left out.
 */
function stepsOf(body: string): CarrierEvent[] {
  const data = json(body, 'order tracking');
  if (!Array.isArray(data) || data.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'Rhenus answered without the order’s steps');
  const events: { event: CarrierEvent; at: number; index: number }[] = [];
  data.forEach((step, index) => {
    if (!isRecord(step) || typeof step.title !== 'string' || !step.title || typeof step.status !== 'string') {
      throw new SchemaError(PROVIDER, 'Rhenus answered a step without its title or status');
    }
    if (step.status !== 'Success') return;
    if (typeof step.date !== 'string' || !INSTANT.test(step.date)) throw new SchemaError(PROVIDER, 'Rhenus answered a done step without its time');
    const known = rhenusDeStatus(step.title);
    events.push({ at: Date.parse(step.date), index, event: {
      time: step.date,
      description: known?.wording ?? step.title,
      provider_code: step.title,
      ...(known ? { stage: known.stage, stage_source: 'carrier_map' } : {}),
    } });
  });
  // The list runs oldest first; steps written in the same second keep that order.
  return events.sort((a, b) => b.at - a.at || b.index - a.index).map(({ event }) => event);
}

/**
 * The order's status and steps. The order's current status sets the stage; the steps give the
 * history and the time of the delivery. The delivery window is the estimate until the order is
 * settled.
 */
export function parseRhenusDe(order: RhenusDeOrder, trackingBody: string): CarrierResult {
  const events = stepsOf(trackingBody);
  const current = rhenusDeStatus(order.currentStatus);
  const newest = events[0];
  const stage = (current?.stage ?? newest?.stage) as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time ?? null : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current?.wording ?? newest?.description ?? order.currentStatus,
    provider_code: order.currentStatus,
    last_update: newest?.time ?? null,
    ...(stage && SETTLED.has(stage) ? { expected_delivery: null } : windowEstimate(order.windowFrom, order.windowTo)),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
