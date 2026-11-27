import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar, escapeRegExp } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { iflowStage, statusMap } from './status.js';

export const PROVIDER = 'iflow';
// An order of a few shipments is a few kilobytes.
export const IFLOW_MAX_BYTES = 512 * 1024;

// The tracker trims and upper-cases what it is given and takes any code: letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const TRACKING_ID = /^\d{1,20}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha/i;
// `dateSort`: an instant with its offset.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// `date`: "07/11/2026 20:29", the wall clock the tracker shows.
const WALL = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// `estimatedDeliveryDate`'s ends: "18/11", a day without its year.
const DAY_MONTH = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/;
// Argentina keeps UTC-03:00 all year.
const ARGENTINA_MS = -3 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_SHIPPINGS = 50;
const MAX_STEPS = 20;
const MAX_STATES = 200;

// Phone and identity numbers in a state's wording: eight digits or more, maybe grouped, and their label.
const DIGITS = /(?<![\p{L}\d])\+?\d(?:[\s.-]?\d){7,}(?!\d)/gu;
const LABEL = /(?:D\.?N\.?I\.?|Tel(?:[ée]fono)?\.?|Cel(?:ular)?\.?|WhatsApp)\s*(?:N[°º]\s*)?[:.]?\s*\uE000/giu;
// Where a removal was, until the text around it is tidied.
const CUT = '\uE000';

/** A code iFLOW's tracker takes: letters and digits with a digit. */
export function normalizeIflowNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the tracking number from iFLOW\'s email');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function jsonOf(body: string, what: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'iFLOW answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, `iFLOW answered its ${what} with a page instead of JSON`, { cause });
  }
}

/** The API's server error, `{"statusCode":500,"message":"Internal server error"}`, which its search gives a code it holds no record of. */
export function isIflowServerError(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && payload.statusCode === 500 && payload.message === 'Internal server error';
  } catch {
    return false;
  }
}

/**
 * The tracker's internal id for a code, from `GET /tracking/order/search/{code}`:
 * `{"tracking_id":"<digits>"}`. A reply without an id is what the tracker words as
 * "No pudimos encontrar tu número de seguimiento".
 */
export function parseIflowSearch(body: string, raw: string): string {
  normalizeIflowNumber(raw);
  const text = body.trim();
  const payload = text ? jsonOf(text, 'search') : null;
  const notFound = () => new NotFoundError(PROVIDER, 'iFLOW could not find this tracking number');
  if (payload === null) throw notFound();
  if (!isRecord(payload)) return invalid('iFLOW returned an invalid search reply');
  const id = payload.tracking_id;
  if (id === undefined || id === null || id === '') {
    // Only an empty reply is the tracker's not-found; anything else without an id is a changed service.
    if (Object.keys(payload).some((key) => key !== 'tracking_id')) return invalid('iFLOW returned a search reply without an id');
    throw notFound();
  }
  const tracking = typeof id === 'number' ? (Number.isSafeInteger(id) && id >= 0 ? String(id) : '') : cleanScalar(id, 24);
  if (!TRACKING_ID.test(tracking)) return invalid('iFLOW returned an invalid tracking id');
  return tracking;
}

/** A state's wording without the names the order gives, phone or identity numbers, and their labels. */
export function withoutPeople(wording: string, names: readonly string[]): string {
  let cut = wording.replaceAll(CUT, '');
  for (const name of names) {
    if (name.length < 3 || !/\p{L}/u.test(name)) continue;
    cut = cut.replace(new RegExp(escapeRegExp(name).replace(/ /g, '\\s+'), 'giu'), CUT);
  }
  cut = cut.replace(DIGITS, CUT).replace(LABEL, CUT);
  if (!cut.includes(CUT)) return clean(cut, 500);
  // A cut takes the spaces around it, and the separator before it when punctuation or the end follows.
  return clean(cut.replace(/\s*\uE000[\s\uE000]*/g, CUT).replace(/\s*[,;:-]?\s*\uE000(?=[,;.)]|$)/g, '')
    .replace(/^\uE000[\s,;:.-]*/, '').replaceAll(CUT, ' '), 500).replace(/\s*[-,;:]$/, '');
}

/** The reply's names: the recipient's and the seller's, kept only to take them out of the wording. */
function namesOf(order: Record<string, unknown>): string[] {
  return [order.receiver, order.sender].map((party) => (isRecord(party) ? clean(party.name, 120) : '')).filter(Boolean);
}

/** A `date` wall clock, or null. */
function wallClock(value: unknown): string | null {
  const parts = WALL.exec(clean(value, 40));
  if (!parts) return null;
  const day = calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1]));
  const [hour, minute, second] = [Number(parts[4]), Number(parts[5]), Number(parts[6] ?? 0)];
  if (!day || hour > 23 || minute > 59 || second > 59) return null;
  return `${day}T${parts[4]!.padStart(2, '0')}:${parts[5]}:${(parts[6] ?? '00').padStart(2, '0')}`;
}

/** Argentina's wall clock of an instant, to the second. */
const argentine = (instant: number): string => new Date(instant + ARGENTINA_MS).toISOString().slice(0, 19);

interface Clock { at: number; time?: string; local?: string }

/**
 * A state's clock: `dateSort`, the instant, with the offset of Argentina's clock that `date`
 * shows. A `date` on another clock than the instant's is what the tracker shows, and stands
 * alone as a wall clock.
 */
function clockOf(sortValue: unknown, shown: unknown): Clock {
  const wall = wallClock(shown);
  const iso = clean(sortValue, 40);
  const instant = INSTANT.test(iso) ? Date.parse(iso) : Number.NaN;
  if (Number.isFinite(instant) && (!wall || wall.slice(0, 16) === argentine(instant).slice(0, 16))) {
    return { at: instant, time: `${new Date(instant + ARGENTINA_MS).toISOString().slice(0, 23)}-03:00` };
  }
  if (wall) return { at: Date.parse(`${wall}-03:00`), local: wall };
  return invalid('iFLOW returned a state without a clock');
}

/** A list of the reply: absent is empty; anything else than a list of objects is a changed reply. */
function rowsOf(value: unknown, max: number, what: string): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) return invalid(`iFLOW returned invalid ${what}`);
  return value;
}

interface Scan { event: CarrierEvent; at: number }

/** One state as the tracker shows it: `date | details - reason`, with its internal state as the code. */
function scanOf(state: Record<string, unknown>, names: readonly string[]): Scan {
  const code = clean(state.ifowState, 80);
  const reason = clean(state.reason, 200);
  const shown = [clean(state.details, 300) || clean(state.state, 120), reason].filter(Boolean).join(' - ');
  const description = withoutPeople(shown, names) || code;
  if (!description) return invalid('iFLOW returned a state without wording');
  const clock = clockOf(state.dateSort, state.date);
  // A state the map does not know is read by its wording, else left without a stage.
  const mapped = code ? iflowStage(code) : undefined;
  const worded = mapped ? null : classifyWording(description, 'in_transit');
  const staged = mapped ? { stage: mapped, stage_source: 'carrier_map' } : worded && worded.source !== 'none'
    ? { stage: worded.stage, stage_source: worded.source } : {};
  return { at: clock.at, event: {
    ...(clock.time ? { time: clock.time } : { local_time: clock.local! }), description, ...(code ? { provider_code: code } : {}), ...staged,
  } };
}

/** The shipping the number asked names, and the shipment's own number when an order number found it. */
function shippingFor(order: Record<string, unknown>, number: string): { shipping: Record<string, unknown>; canonical?: string } {
  const shippings = rowsOf(order.shippings, MAX_SHIPPINGS, 'shipments');
  const own = (shipping: Record<string, unknown>) => normalizeTrackingNumber(cleanScalar(shipping.shipment_id, 64));
  const matching = shippings.filter((shipping) => own(shipping) === number);
  if (matching.length > 1) return invalid('iFLOW listed one shipment twice');
  if (matching.length === 1) return { shipping: matching[0]! };
  // The seller's order number names its order; its one shipment is the parcel.
  if (normalizeTrackingNumber(cleanScalar(order.order_id, 64)) === number) {
    const [only] = shippings;
    if (shippings.length === 1 && NUMBER.test(own(only!))) return { shipping: only!, canonical: own(only!) };
    throw new IndeterminateError(PROVIDER, 'iFLOW holds several shipments under this order number: look each up by its own number');
  }
  throw new IndeterminateError(PROVIDER, 'iFLOW answered for another parcel');
}

/** The day an end of the window falls on, as "DD/MM" names it, nearest `near` and at most `within` days from it. */
function dayNear(text: string, near: string, within: number, onOrAfter: boolean): string | null {
  const parts = DAY_MONTH.exec(text);
  if (!parts) return null;
  const [day, month] = [Number(parts[1]), Number(parts[2])];
  const year = Number(near.slice(0, 4));
  const years = parts[3] ? [Number(parts[3])] : [year - 1, year, year + 1];
  const base = Date.parse(`${near}T00:00:00Z`);
  const candidates = years.map((candidate) => calendarDay(candidate, month, day))
    .filter((candidate): candidate is string => candidate !== null && (!onOrAfter || candidate >= near))
    .map((candidate) => ({ candidate, distance: Math.abs(Date.parse(`${candidate}T00:00:00Z`) - base) / DAY_MS }))
    .filter(({ distance }) => distance <= within)
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.candidate ?? null;
}

/**
 * The shipment's delivery window, `{"min":"18/11","max":"20/11"}`, which the tracker shows only
 * with both ends. The ends carry no year: the start is the day nearest the newest state's
 * Argentine day, within 90 days, and the end the first such day from the start, within 45. A
 * window that cannot be placed so is left unread.
 */
function estimateOf(value: unknown, newest: string): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from' | 'unread_estimates'> {
  if (value === null || value === undefined) return { expected_delivery: null };
  const unread = { expected_delivery: null, ...unreadEstimates({ estimatedDeliveryDate: value }) };
  if (!isRecord(value)) return unread;
  const [min, max] = [clean(value.min, 20), clean(value.max, 20)];
  if (!min || !max) return { expected_delivery: null };
  const from = dayNear(min, newest, 90, false);
  const to = from ? dayNear(max, from, 45, true) : null;
  if (!from || !to) return unread;
  return { expected_delivery: to, ...(to > from ? { expected_delivery_from: from } : {}) };
}

/**
 * The order of `GET /tracking/order/{tracking_id}`, for the code that the search gave that id.
 * The parcel is the shipping whose `shipment_id` is the number asked, or the one shipping of an
 * order whose `order_id`, the seller's order number, is. Its steps hold its states oldest first;
 * a step without states is still to come. The recipient's and seller's names, the seller's
 * order number, the label link and the satisfaction survey are not read.
 */
export function parseIflowOrder(payload: unknown, raw: string, trackingId: string): CarrierResult {
  const number = normalizeIflowNumber(raw);
  if (!isRecord(payload)) return invalid('iFLOW returned an invalid order');
  const own = cleanScalar(payload.tracking_id, 24);
  // The tracker shows nothing for an order without its id ("La etiqueta no existe"), which the search has just found.
  if (!own) throw new IndeterminateError(PROVIDER, 'iFLOW found the code but not its order');
  if (own !== trackingId) throw new IndeterminateError(PROVIDER, 'iFLOW answered for another order');
  const { shipping, canonical } = shippingFor(payload, number);
  const names = namesOf(payload);
  const states = rowsOf(shipping.steps, MAX_STEPS, 'steps').flatMap((step) => rowsOf(step.states, MAX_STATES, 'states'));
  if (states.length > MAX_STATES) return invalid('iFLOW returned an oversized history');
  // The order lists the shipment, which has no state yet.
  if (!states.length) throw new NoHistoryError(PROVIDER, 'iFLOW lists the shipment without a state yet', { reason: 'listed' });

  // Oldest first in the reply; newest first here, a clock's states in the reverse of the reply's order.
  const scans = states.map((state) => scanOf(state, names)).reverse().sort((a, b) => b.at - a.at);
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const finished = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    ...(newest.provider_code ? { provider_code: newest.provider_code } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    ...(finished ? { expected_delivery: null } : estimateOf(shipping.estimatedDeliveryDate, argentine(scans[0]!.at).slice(0, 10))),
    ...(canonical ? { canonical_tracking_number: canonical } : {}),
    events,
  };
}

/** The order read's body: its JSON, a browser check, or a changed service. */
export function parseIflowOrderReply(body: string, raw: string, trackingId: string): CarrierResult {
  return parseIflowOrder(jsonOf(body, 'order'), raw, trackingId);
}
