import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { CARGOMINI_EVENT_TITLES, cargominiEventStage, statusMap } from './status.js';

export const PROVIDER = 'CargoMini';
export const CARRIER = 'cargomini';
// A consignment with twenty events is about 4 kB.
export const CARGOMINI_MAX_BYTES = 256 * 1024;

// The tracker takes the number as its path: letters and digits, with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 300;

// The consignment's status, as the tracking page's script names it, with its stage.
const STATUSES: ReadonlyMap<number, { stage: Stage; label: string }> = new Map([
  [1, { stage: 'registered', label: 'Waiting For Pickup' }],
  [2, { stage: 'in_transit', label: 'In Transit' }],
  [3, { stage: 'exception', label: 'Need Action' }],
  [4, { stage: 'customs', label: 'In Customs' }],
  [5, { stage: 'delivered', label: 'Delivered' }],
  [6, { stage: 'failed_attempt', label: 'Not Delivered' }],
]);

/** A number for CargoMini's tracker, in capitals. */
export function normalizeCargominiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CargoMini tracks consignments by 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isCargominiBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`CargoMini returned an invalid ${what}`);
}

/**
 * One event: its code, its instant, which the tracker gives with its offset, and its wording,
 * else the tracking page's title for its code. Kolay Gelsin's and other last-mile carriers'
 * scans come with code 11 and their own wording.
 */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('CargoMini returned an invalid event');
  if (typeof row.event !== 'number' || !Number.isSafeInteger(row.event) || row.event < 0) return invalid('CargoMini returned an invalid event code');
  const code = String(row.event);
  const instant = typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.date) ? explicitOffsetTime(row.date) : null;
  if (!instant) return invalid('CargoMini returned an event without its time');
  const description = text(row.description, 300, 'event') || CARGOMINI_EVENT_TITLES.get(code) || `Event ${code}`;
  const location = text(row.location, 120, 'event place');
  const staged = cargominiEventStage(code, description);
  return {
    time: instant.iso,
    description,
    ...(location ? { location } : {}),
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * Whether the number has the partner's shape: one of the partner's detection
 * rules offers it, or the partner's own tracking link in the reply opens it.
 */
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as readonly string[]).includes(partner)) return true;
  const linked = link ? parseTrackingInput(link) : null;
  return linked?.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/**
 * The last-mile carrier's number, and the carrier when its name and link are one catalog
 * carrier's and the number has that carrier's shape. The link is never followed.
 */
function handoff(payload: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = normalizeTrackingNumber(text(payload.innerConsNo, 64, 'last-mile number')).toUpperCase();
  if (!REFERENCE.test(reference) || reference === number) return {};
  const firm = text(payload.shipperFirm, 80, 'last-mile carrier');
  const link = text(payload.innerTrackingUrl, 500, 'last-mile link');
  const carrier = firm || link ? carrierIdFromPartner(firm, link) : undefined;
  const named = carrier && carrier !== CARRIER && partnerShape(carrier, reference, link) ? carrier : undefined;
  return { ...(named ? { delivery_carrier: named } : {}), delivery_tracking_number: reference };
}

/** Newest first; the tracker lists events oldest first. Ties keep the tracker's order. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events.map((event, index) => ({ event, index, at: Date.parse(event.time as string) }))
    .sort((a, b) => b.at - a.at || b.index - a.index).map(({ event }) => event);
}

/**
 * The reply of `api.kargomkolay.com/v1/tracking/<number>`, the lookup CargoMini's tracking
 * page makes. It repeats the consignment number, gives the consignment's status code, the
 * last-mile carrier's name, number and tracking link, and the events oldest first, each with
 * a code, an instant with its offset and, mostly, a wording.
 *
 * The sender, the recipient's masked name, postcode and town, the shop's order reference and
 * the weight are never read.
 */
export function parseCargomini(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCargominiNumber(raw);
  if (!isRecord(payload) || typeof payload.consignmentNo !== 'string') return invalid('CargoMini returned an unexpected reply');
  // The reply must name the consignment asked.
  if (normalizeTrackingNumber(payload.consignmentNo).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'CargoMini answered for another consignment');
  }
  if (payload.events !== null && payload.events !== undefined && !Array.isArray(payload.events)) return invalid('CargoMini returned invalid events');
  const rows = (payload.events ?? []) as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('CargoMini returned too many events');
  const status = typeof payload.status === 'number' ? STATUSES.get(payload.status) : undefined;
  const facts = handoff(payload, number);
  const events = newestFirst(rows.map(eventOf));
  const newest = events[0];
  if (!newest) {
    if (!status) throw new NoHistoryError(PROVIDER, 'CargoMini lists the consignment without events', { reason: 'listed', deliveryCarrier: facts.delivery_carrier, deliveryTrackingNumber: facts.delivery_tracking_number });
    return {
      status: languageStageStatus(status.stage), current_stage: status.stage, current_stage_source: 'carrier_map',
      provider_code: String(payload.status), last_status_text: status.label, last_update: null, expected_delivery: null,
      ...facts, summary_only: true, events: [],
    };
  }
  // The newest event with a stage leads; the consignment's status stands in when none has one.
  const lead = leadingScan(events, statusMap);
  const stage = (lead?.stage ?? status?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage ? lead.stage_source ?? 'carrier_map' : 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...facts,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function cargominiJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isCargominiBlocked(body)) throw new ChallengeError(PROVIDER, 'CargoMini answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'CargoMini returned a reply that is not JSON', { cause });
  }
}
