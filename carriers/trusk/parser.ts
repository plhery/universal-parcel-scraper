import { validateTruskTrackingUrl } from '../../core/catalog/urls.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { truskLabel, truskStage } from './status.js';

export const PROVIDER = 'trusk';
/** The read the order page's script makes, `GET /api/order/<order>`. */
export const TRUSK_LOOKUP = 'https://track.trusk.com/api/order/';
// An order's reply is about 1 kB.
export const TRUSK_MAX_BYTES = 256 * 1024;
/** The lookup's answers, with HTTP 404, for an order id it holds no order under. */
export const TRUSK_NOT_FOUND = new Set(['order_not_recoverable', 'Not Found']);

// The order id in capitals, as the tracking number keeps it: six to 32 letters, digits and underscores.
const NUMBER = /^[A-Z0-9_]{6,32}$/;
// A firewall's, CDN's or bot check's page in place of the lookup's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// A step's state: done, failed, cancelled, under way or still to come.
const STATES = new Set(['success', 'error', 'aborted', 'inprogress', 'waiting']);
// The order page's placeholder in place of a step's time.
const WAITING = 'waiting';
const MAX_STEPS = 40;
const MAX_TIMES = 20;
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** An order's tracking number: its order id in capitals, as detection keeps it. */
export function normalizeTruskNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Trusk order ids have 6 to 32 letters, digits, hyphens and underscores');
  return number;
}

/**
 * The order id as the order link writes it. The lookup matches the id case-sensitively, and the
 * tracking number keeps it only in capitals, so the id is read from the link.
 */
export function truskOrderId(trackingUrl: string, raw: string): string {
  const number = normalizeTruskNumber(raw);
  try {
    return new URL(validateTruskTrackingUrl(trackingUrl, number)).pathname.slice(1);
  } catch (cause) {
    throw new InvalidInputError(PROVIDER, cause instanceof Error ? cause.message : 'Invalid Trusk order link');
  }
}

/** Whether a reply is a block page instead of the lookup's JSON. */
export function isTruskBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** The lookup's reply as JSON, or the reason it is not one. */
export function truskJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isTruskBlocked(body)) throw new ChallengeError(PROVIDER, 'Trusk answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Trusk returned a reply that is not JSON', { cause });
  }
}

/** The lookup's own not-found answer, `{"error": …}`, or undefined for any other reply. */
export function truskNotFound(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.error === 'string' && TRUSK_NOT_FOUND.has(payload.error) && Object.keys(payload).length === 1;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

interface Step { code: string; state: string; times: string[] }

/** One step of the order's timeline: its key, its state and the instants it happened at. */
function stepOf(row: unknown): Step {
  if (!isRecord(row) || typeof row.title !== 'string' || typeof row.state !== 'string' || !Array.isArray(row.subtitles)) {
    return invalid('Trusk returned an invalid step');
  }
  const code = clean(row.title, 60);
  if (!/^[a-z_]{2,60}$/.test(code)) return invalid('Trusk returned a step without its key');
  if (!STATES.has(row.state)) return invalid('Trusk returned a step in a state its page does not have');
  if (row.subtitles.length > MAX_TIMES) return invalid('Trusk returned too many times for a step');
  const times = row.subtitles.flatMap((value: unknown) => {
    if (value === WAITING) return [];
    // The page shows each as a day and a time; the reply writes the instant in UTC.
    const instant = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? explicitOffsetTime(value) : null;
    return instant ? [instant.iso] : invalid('Trusk returned a step with an invalid time');
  });
  return { code, state: row.state, times };
}

/** A step's stage: a failed or cancelled step that moves the order on is a problem instead. */
function stageOf(step: Step): Stage | undefined {
  const stage = truskStage(step.code);
  if (!stage || (step.state !== 'error' && step.state !== 'aborted')) return stage;
  return stage === 'exception' || stage === 'failed_attempt' ? stage : 'exception';
}

function eventsOf(steps: readonly Step[]): CarrierEvent[] {
  const events = steps.flatMap((step) => step.times.map((time): CarrierEvent => {
    const stage = stageOf(step);
    return {
      time,
      description: truskLabel(step.code) ?? step.code,
      provider_code: step.code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  }));
  // The timeline runs oldest first; events are read newest first.
  return events.map((event, index) => ({ event, index }))
    .sort((a, b) => Date.parse(b.event.time!) - Date.parse(a.event.time!) || b.index - a.index)
    .map(({ event }) => event);
}

function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`Trusk returned an invalid ${what}`);
}

/**
 * The reply of `GET track.trusk.com/api/order/<order>`, the read Trusk's order page makes. It
 * holds the order's timeline (each step's key, its state and the instants it happened at), the
 * booked delivery slot, the retailer and the goods' weight. The recipient's masked name, phone
 * and address, the retailer's order number, the driver and the delivery options are never read.
 * The reply does not repeat the order id; the request names it.
 */
export function parseTrusk(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.timeline)) return invalid('Trusk returned an order without its timeline');
  if (payload.timeline.length > MAX_STEPS) return invalid('Trusk returned too many steps');
  const steps = payload.timeline.map(stepOf);
  const info = payload.deliveryInfos;
  if (info !== null && info !== undefined && !isRecord(info)) return invalid('Trusk returned invalid delivery details');
  const details = isRecord(info) ? info : {};
  const brand = text(details.brand, 80, 'retailer');
  const weight = typeof details.weight === 'number' && Number.isFinite(details.weight) && details.weight > 0 && details.weight < 100_000
    ? Math.round(details.weight * 100) / 100 : null;
  const facts = { ...(brand ? { sender_name: brand } : {}), ...(weight ? { weight_kg: weight } : {}) };

  const events = eventsOf(steps);
  const delivered = payload.isDropoffCompletedSuccessful === true;
  // The newest step with a time leads. A step done without one (older orders keep only some
  // times) still counts: the furthest such step leads when it comes later in the timeline.
  const lead = events.find((event) => event.stage);
  const lastAt = (test: (step: Step) => boolean) => steps.reduce((found, step, index) => (test(step) ? index : found), -1);
  const reachedAt = lastAt((step) => step.state !== 'waiting' && stageOf(step) !== undefined);
  const leadAt = lead ? lastAt((step) => step.code === lead.provider_code) : -1;
  const reached = reachedAt > leadAt ? steps[reachedAt] : undefined;
  const stage: Stage | undefined = delivered ? 'delivered' : reached ? stageOf(reached) : lead?.stage as Stage | undefined;
  const newest = events[0];
  const statusText = delivered && newest?.stage !== 'delivered' ? truskLabel('dropoff_completed')!
    : reached ? truskLabel(reached.code) ?? reached.code : newest?.description ?? '';
  if (!stage && !statusText) throw new NoHistoryError(PROVIDER, 'Trusk lists the order without a step');

  const slot = payload.slot;
  if (slot !== null && slot !== undefined && !isRecord(slot)) return invalid('Trusk returned an invalid delivery slot');
  // The slot holds once it is booked: while the recipient still has one to choose, it is none.
  const unbooked = steps.some((step) => step.code === 'waiting_for_appointment' && step.state === 'waiting');
  const estimate = (stage && FINAL.has(stage)) || unbooked || !isRecord(slot) ? { expected_delivery: null }
    : windowEstimate(slot.start, slot.end);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: statusText || null,
    last_update: newest?.time ?? null,
    ...estimate,
    ...facts,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
