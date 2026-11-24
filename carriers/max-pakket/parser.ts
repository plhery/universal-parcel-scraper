import { MENDRIX_TRACE_CODE } from '../../core/catalog/urls.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { maxPakketStage } from './status.js';

export const PROVIDER = 'max-pakket';
/** MAX Pakket's tenant of the Mendrix tracking app. */
export const MENDRIX_HOST = 'emens.mendrix.cloud';
/** The API the tracking app's script reads, on the app's own host. */
export const MENDRIX_API = `https://${MENDRIX_HOST}/WorldLink/TrackAndTrace/v1`;
/** The session cookie the address lookup sets, which names the order it opened. */
export const MENDRIX_SESSION_COOKIE = 'mxtt_traceinfo';
// Each milestone repeats the order's summary with the delivery signature as an image.
export const MENDRIX_MAX_BYTES = 2 * 1024 * 1024;

// The API's answer for a code and order number it holds no order under: "(invalid order)" when the
// order number is unknown, "(invalid task))" when the code is not that order's.
const NOT_FOUND = /^Invalid TraceInfo: unable to find traced route \(invalid (?:order|task)\)+$/;
// A firewall's, CDN's or bot check's page in place of the API's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// A wall clock without an offset; the API writes its moments with one.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;
const MAX_TRACES = 300;
const MAX_MILESTONES = 20;

const REGISTERED = 'E_MILESTONES_NAME_REGISTERED';
const IN_TRANSIT = 'E_MILESTONES_NAME_INTRANSIT';
const PICKED_UP = 'E_MILESTONES_NAME_PICKEDUP';
const DELIVERED = 'E_MILESTONES_NAME_DELIVERED';
const ACTIVE = 'E_MILESTONES_STATUSCODE_ACTIVE';
const COMPLETED = 'E_MILESTONES_STATUSCODE_COMPLETED';
// How the tracking app words a completed last milestone: "Succesvol afgeleverd", "Gedeeltelijk opgehaald".
const COMPLETION: Readonly<Record<string, string>> = {
  E_MILESTONES_COMPLETION_STATUSCODE_SUCCES: 'Succesvol',
  E_MILESTONES_COMPLETION_STATUSCODE_PARTIALLY_SUCCESSFUL: 'Gedeeltelijk',
  E_MILESTONES_COMPLETION_STATUSCODE_UNSUCCESSFUL: 'Niet succesvol',
};

/** A Track & Trace code for the tracking app: MXTT and hexadecimal digits, in capitals. */
export function normalizeMaxPakketCode(raw: string): string {
  const code = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!MENDRIX_TRACE_CODE.test(code)) throw new InvalidInputError(PROVIDER, 'MAX Pakket tracks Track & Trace codes of MXTT and hexadecimal digits');
  return code;
}

/** Whether a reply is a block page instead of the API's JSON. */
export function isMendrixBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** The API's reply as JSON, or the reason it is not one. */
export function mendrixJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isMendrixBlocked(body)) throw new ChallengeError(PROVIDER, 'MAX Pakket answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'MAX Pakket returned a reply that is not JSON', { cause });
  }
}

/**
 * The API's refusal, `TEoTrackAndTrace_Error_Response` with a message. Only its answer for a code
 * and order number it holds no order under is not found; a refusal of the session or another
 * message leaves the answer open.
 */
export function mendrixRefusal(payload: unknown): never {
  const message = isRecord(payload) && payload.type === 'TEoTrackAndTrace_Error_Response' && typeof payload.Msg === 'string'
    ? clean(payload.Msg, 200) : '';
  if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER, 'MAX Pakket has no order under this Track & Trace code and order number');
  if (/No TraceInfo|Re-authentication/i.test(message)) {
    throw new IndeterminateError(PROVIDER, 'MAX Pakket did not accept the tracking link', { reason: 'session_rejected' });
  }
  throw new IndeterminateError(PROVIDER, 'MAX Pakket did not complete the lookup');
}

/**
 * The order the session cookie names: `<base64 JSON>.<signature>`, the JSON holding the Track &
 * Trace code, the order number and the client the lookup opened. Null for a cookie of another
 * shape or one that opened no client's order.
 */
export function mendrixSessionOrder(value: string): { code: string; orderId: string } | null {
  const token = /^([A-Za-z0-9+/_-]{8,4096}={0,2})\.[0-9a-f]{16,256}$/.exec(value)?.[1];
  if (!token) return null;
  let info: unknown;
  try { info = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
  // The API sets one on a refusal too, with no client.
  if (!isRecord(info) || typeof info.Tracecode !== 'string' || !Number.isSafeInteger(info.OrderId)
    || !Number.isSafeInteger(info.ClientId) || (info.ClientId as number) <= 0) return null;
  return { code: info.Tracecode.trim().toUpperCase(), orderId: String(info.OrderId) };
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`MAX Pakket returned an invalid ${what}`);
}

/** A moment: an instant keeps its offset, a wall clock without one stays a wall clock. Null when absent. */
function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> | null {
  const raw = text(value, 64, 'moment');
  // The app's empty moment is the year one.
  if (!raw || /^0\d{3}-/.test(raw)) return null;
  const instant = explicitOffsetTime(raw);
  if (instant) return { time: instant.iso };
  const wall = WALL_CLOCK.exec(raw);
  const day = wall && calendarDay(Number(wall[1]), Number(wall[2]), Number(wall[3]));
  if (!wall || !day) return invalid('MAX Pakket returned an invalid moment');
  return { local_time: `${day}T${wall[4]}:${wall[5]}:${wall[6] ?? '00'}` };
}

function staged(description: string): Pick<CarrierEvent, 'stage' | 'stage_source'> {
  const stage = maxPakketStage(description);
  return stage ? { stage: stage.stage, stage_source: stage.source } : {};
}

interface Milestone { name: string; status: string; completion: string; sort: number }

/** The milestones in the app's order, and the order's summary they each repeat. */
function milestonesOf(payload: unknown): { milestones: Milestone[]; summary: Record<string, unknown> } {
  if (!isRecord(payload) || payload.type !== 'TEoTrackAndTrace_MilestoneList_Response' || !Array.isArray(payload.Milestones)) {
    return invalid('MAX Pakket returned an unexpected milestone list');
  }
  if (payload.Milestones.length > MAX_MILESTONES) return invalid('MAX Pakket returned too many milestones');
  let summary: Record<string, unknown> = {};
  const milestones = payload.Milestones.map((row: unknown, index): Milestone => {
    if (!isRecord(row) || typeof row.Name !== 'string' || typeof row.StatusCode !== 'string') return invalid('MAX Pakket returned an invalid milestone');
    if (isRecord(row.StatusSummary) && !Object.keys(summary).length) summary = row.StatusSummary;
    return { name: row.Name, status: row.StatusCode, completion: text(row.CompletionStatusCode, 80, 'milestone'),
      sort: typeof row.SortId === 'number' && Number.isFinite(row.SortId) ? row.SortId : index };
  }).sort((a, b) => a.sort - b.sort);
  return { milestones, summary };
}

/** The scans, as the app lists them: a wording, its moment and whether it succeeded. */
function tracesOf(payload: unknown): CarrierEvent[] {
  if (!isRecord(payload) || payload.type !== 'TEoTrackAndTrace_TraceList_Response' || !Array.isArray(payload.Traces)) {
    return invalid('MAX Pakket returned an unexpected scan list');
  }
  if (payload.Traces.length > MAX_TRACES) return invalid('MAX Pakket returned too many scans');
  return payload.Traces.map((row: unknown): CarrierEvent => {
    if (!isRecord(row)) return invalid('MAX Pakket returned an invalid scan');
    const description = text(row.Description, 200, 'scan') || invalid('MAX Pakket returned a scan without its wording');
    const clock = clockOf(row.Moment) ?? invalid('MAX Pakket returned a scan without its moment');
    return { ...clock, description, ...staged(description) };
  });
}

const epoch = (event: CarrierEvent) => Date.parse(event.time ?? `${event.local_time}Z`);

/**
 * The replies of the API's `/milestones` and `/traces` for an order the session opened. The
 * milestones carry the order's summary, which the tracking app shows: when the order was
 * registered, the requested, planned and actual times of its stop, the signature and the
 * signee's name. The scans, when the order has any, are its history; an order without scans
 * gets its registration and its completed stop from the summary.
 *
 * The signature, the signee's name and the sender's name are never read.
 */
export function parseMaxPakket(milestonesPayload: unknown, tracesPayload: unknown, raw: string): CarrierResult {
  normalizeMaxPakketCode(raw);
  const { milestones, summary } = milestonesOf(milestonesPayload);
  const scans = tracesOf(tracesPayload);
  const reachedAll = milestones.filter((milestone) => milestone.status === COMPLETED || milestone.status === ACTIVE);
  const reached = reachedAll.at(-1);
  const last = reached && [DELIVERED, PICKED_UP].includes(reached.name) && reached.status === COMPLETED && COMPLETION[reached.completion]
    ? reached : undefined;
  // A completed stop is dated by the driver's departure, as the app dates it, else the arrival.
  const stopClock = last ? clockOf(summary.MomentAtd) ?? clockOf(summary.MomentAta) : null;
  const lastWording = last ? `${COMPLETION[last.completion]} ${last.name === PICKED_UP ? 'opgehaald' : 'afgeleverd'}` : '';
  const registeredClock = reachedAll.some((milestone) => milestone.name === REGISTERED) ? clockOf(summary.OrderMoment) : null;

  const events: CarrierEvent[] = scans.length ? [...scans] : [
    ...(stopClock ? [{ ...stopClock, description: lastWording, ...staged(lastWording) }] : []),
    ...(registeredClock ? [{ ...registeredClock, description: 'Aangemeld', ...staged('Aangemeld') }] : []),
  ];
  events.sort((a, b) => epoch(b) - epoch(a));

  // The order's state is the milestone it has reached, as the app's summary shows it.
  const wording = last ? lastWording
    : reached?.name === REGISTERED ? 'Aangemeld'
      : reached?.name === IN_TRANSIT || reached?.name === DELIVERED || reached?.name === PICKED_UP ? 'Onderweg' : '';
  const newest = events[0];
  if (!wording && !newest) throw new NoHistoryError(PROVIDER, 'MAX Pakket lists the order without a milestone or scan', { reason: 'listed' });
  const status = wording || newest!.description!;
  const stage = maxPakketStage(status);
  const delivered = last?.completion === 'E_MILESTONES_COMPLETION_STATUSCODE_SUCCES' && last.name === DELIVERED;
  // An order not yet completed is due in its planned window, else in the window it was booked for.
  const planned = windowEstimate(summary.MomentPta, summary.MomentPtd);
  const estimate = last ? { expected_delivery: null }
    : planned.expected_delivery && clockOf(summary.MomentPta) ? planned
      : clockOf(summary.MomentRta) ? windowEstimate(summary.MomentRta, summary.MomentRtd) : { expected_delivery: null };
  return {
    status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: status,
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    ...estimate,
    ...(delivered && stopClock?.time ? { delivered_at: stopClock.time } : {}),
    events,
  };
}
