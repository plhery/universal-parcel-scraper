import { carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { boxcEventStage, boxcStatusStage, statusMap } from './status.js';

export const PROVIDER = 'boxc';
/** The lookup BoxC's tracking page posts `{"trackingNumber": <number>}` to. */
export const BOXC_LOOKUP = 'https://boxc.com/api/track';
// A shipment's reply without events is about 400 bytes.
export const BOXC_MAX_BYTES = 512 * 1024;
/** The tracker's answer for a number it holds no shipment under, with HTTP 200. */
export const BOXC_NOT_FOUND = 'Shipment not found';

// The tracking page's own check: 8 to 40 letters and digits. Every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2024-05-26 07:11:45": the event's wall clock, in the scan's own zone, as BoxC documents it.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,6})?)?$/;
const MAX_EVENTS = 300;

/** A number for BoxC's tracker: its own label's or the final-mile carrier's, in capitals. */
export function normalizeBoxcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BoxC tracks numbers of 8 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isBoxcBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`BoxC returned an invalid ${what}`);
}

/** An event's clock: a wall clock without a zone stays one, an instant keeps its offset. */
function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const raw = typeof value === 'string' ? value.trim() : '';
  const wall = WALL_CLOCK.exec(raw);
  if (wall) {
    const day = calendarDay(Number(wall[1]), Number(wall[2]), Number(wall[3]));
    if (!day || Number(wall[1]) < 2000) return invalid('BoxC returned an invalid event time');
    return { local_time: `${day}T${wall[4]}:${wall[5]}:${wall[6] ?? '00'}` };
  }
  const instant = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? explicitOffsetTime(raw) : null;
  return instant ? { time: instant.iso } : invalid('BoxC returned an event without its time');
}

/**
 * One event, as the API documentation defines it: a code from BoxC's dictionary, its wording,
 * the clock and the place. The postcode and the coordinates are never read: a delivery's give
 * the recipient's address.
 */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('BoxC returned an invalid event');
  const description = text(row.description, 200, 'event') || invalid('BoxC returned an event without its wording');
  const code = row.code === null || row.code === undefined ? null
    : typeof row.code === 'number' && Number.isSafeInteger(row.code) && row.code >= 0 ? String(row.code)
      : typeof row.code === 'string' && /^\d{1,6}$/.test(row.code.trim()) ? row.code.trim() : invalid('BoxC returned an invalid event code');
  const location = [text(row.city, 80, 'event place'), text(row.province, 80, 'event place'), text(row.country, 40, 'event place')]
    .filter(Boolean).join(', ');
  const staged = boxcEventStage(code, description);
  return {
    ...clockOf(row.time),
    description,
    ...(location ? { location } : {}),
    ...(code === null ? {} : { provider_code: code }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The final-mile carrier the reply names, when its name is one catalog carrier's and that
 * carrier's rules fit the number: the tracker then follows the parcel under that carrier's own
 * number, the one asked.
 */
function deliveryPartner(value: unknown, number: string): Pick<CarrierResult, 'delivery_carrier'> {
  const name = text(value, 80, 'carrier');
  const partner = name ? carrierIdFromName(name) : undefined;
  return partner && partner !== PROVIDER && (detectCarrierMatch(number).candidates as readonly string[]).includes(partner)
    ? { delivery_carrier: partner } : {};
}

/** The tracker's answer when it did not find or did not read a shipment: `success: false`, a status code and a message. */
function refusal(payload: Record<string, unknown>): never {
  const status = payload.apiStatus;
  const message = typeof payload.data === 'string' ? payload.data : typeof payload.message === 'string' ? payload.message : '';
  // The tracker's own answer for a number it holds no shipment under. It does not repeat the
  // number; the request for it does.
  if (status === 404 && clean(message, 100) === BOXC_NOT_FOUND) throw new NotFoundError(PROVIDER, 'BoxC has no shipment under this number');
  if (status === 429) throw new RateLimitedError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'BoxC did not complete the lookup');
}

/**
 * The reply of `POST boxc.com/api/track`, the lookup BoxC's tracking page makes. A shipment's
 * reply names its number, its status, the final-mile carrier, the service, the destination and
 * its events, newest first. BoxC merges the first, middle and last miles into those events,
 * each on the scan's wall clock. A shipment without events stands on its status alone.
 *
 * The destination's town and province, the merchant's order number, BoxC's shipment id and the
 * delivery images are never read.
 */
export function parseBoxc(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBoxcNumber(raw);
  if (!isRecord(payload)) return invalid('BoxC returned an unexpected reply');
  if (payload.success === false) refusal(payload);
  if (typeof payload.tracking_number !== 'string' || typeof payload.status !== 'string') {
    return invalid('BoxC returned a shipment without its number or status');
  }
  // The reply must name the number asked.
  if (normalizeTrackingNumber(payload.tracking_number).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'BoxC answered for another shipment');
  }
  if (payload.events !== null && payload.events !== undefined && !Array.isArray(payload.events)) return invalid('BoxC returned invalid events');
  const rows = (payload.events ?? []) as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('BoxC returned too many events');
  if (payload.destination !== null && payload.destination !== undefined && !isRecord(payload.destination)) {
    return invalid('BoxC returned an invalid destination');
  }
  const destination = isRecord(payload.destination) ? payload.destination : {};
  const country = text(destination.country, 8, 'destination').toUpperCase();
  const service = text(payload.service, 80, 'service');
  const facts = {
    ...(service ? { service_name: service } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...deliveryPartner(payload.carrier, number),
  };
  const wording = text(payload.status, 80, 'status');
  const summary = wording ? boxcStatusStage(wording) : null;
  const events = rows.map(eventOf);
  const newest = events[0];
  if (!newest) {
    if (!wording) throw new NoHistoryError(PROVIDER, 'BoxC lists the shipment without a status', { reason: 'listed', deliveryCarrier: facts.delivery_carrier });
    return {
      status: summary ? languageStageStatus(summary.stage) : 'unknown',
      ...(summary ? { current_stage: summary.stage, current_stage_source: summary.source } : {}),
      last_status_text: wording, last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [],
    };
  }
  // The newest event with a stage leads; the shipment's status stands in when none has one.
  const lead = leadingScan(events, statusMap);
  const stage = (lead?.stage ?? summary?.stage) as Stage | undefined;
  const source = lead?.stage ? lead.stage_source : summary?.source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...facts,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function boxcJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isBoxcBlocked(body)) throw new ChallengeError(PROVIDER, 'BoxC answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'BoxC returned a reply that is not JSON', { cause });
  }
}
