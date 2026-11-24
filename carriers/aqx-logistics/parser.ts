import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { aqxStage, statusMap } from './status.js';

export const PROVIDER = 'aqx-logistics';
/** The lookup AQX's tracking page reads with `?id=<number>`. */
export const AQX_LOOKUP = 'https://aqxlogistics.com/api/track';
// A shipment's reply with a few events is under 2 KB.
export const AQX_MAX_BYTES = 256 * 1024;
/** The tracker's answer, with HTTP 404, for a number it holds no shipment under. */
export const AQX_NOT_FOUND = 'Shipment not found. Please check your tracking number.';

// AQX's own shipment reference: HF- and eight hexadecimal characters, the hyphen optional.
const NUMBER = /^HF-?([0-9A-F]{8})$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 200;

/** An AQX reference as the tracker prints it: HF-, then eight hexadecimal characters in capitals. */
export function normalizeAqxNumber(raw: string): string {
  const typed = typeof raw === 'string' && raw.length <= 64 ? raw.trim().toUpperCase().replace(/\s+/g, '') : '';
  const match = NUMBER.exec(typed);
  if (!match) throw new InvalidInputError(PROVIDER, 'AQX Logistics tracks references of HF- and eight hexadecimal characters');
  return `HF-${match[1]}`;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isAqxBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, or nothing; anything but a string or null is a changed reply. */
function text(value: unknown, max: number, what: string): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid(`AQX Logistics returned an invalid ${what}`);
}

/**
 * One event: its status, the facility's town and the instant, which the reply gives in UTC. The
 * event's free-text description is never read: it repeats the status or names the parcel.
 */
function eventOf(row: unknown, index: number): { at: number; index: number; event: CarrierEvent } {
  if (!isRecord(row)) return invalid('AQX Logistics returned an invalid event');
  const description = text(row.status, 120, 'event') || invalid('AQX Logistics returned an event without its status');
  const instant = typeof row.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.timestamp) ? explicitOffsetTime(row.timestamp) : null;
  if (!instant) return invalid('AQX Logistics returned an event without its time');
  const location = text(row.location, 120, 'event place');
  const staged = aqxStage(description);
  return { at: instant.timestamp, index, event: {
    time: instant.iso,
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The tracker's refusals with HTTP 400 or 404: only its own not-found answer is read as not found. */
export function aqxRefusal(payload: unknown, status: number): never {
  const message = isRecord(payload) ? clean(payload.error, 200) : '';
  // The answer does not repeat the number; the request for it does.
  if (status === 404 && message === AQX_NOT_FOUND) throw new NotFoundError(PROVIDER, 'AQX Logistics has no shipment under this number');
  throw new IndeterminateError(PROVIDER, 'AQX Logistics did not complete the lookup', { status });
}

/**
 * The reply of `GET aqxlogistics.com/api/track?id=<number>`, the lookup AQX's tracking page makes.
 * A shipment's reply names its reference, its current status, the service, the origin and the
 * destination, the weight and its events, oldest first, each an instant in UTC.
 *
 * The recipient's masked name, the destination town and the event descriptions are never read.
 */
export function parseAqx(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAqxNumber(raw);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.shipment)) return invalid('AQX Logistics returned an unexpected reply');
  const shipment = payload.shipment;
  if (typeof shipment.aqxTrackingId !== 'string' || typeof shipment.status !== 'string') {
    return invalid('AQX Logistics returned a shipment without its reference or status');
  }
  // The reply must name the number asked.
  if (normalizeTrackingNumber(shipment.aqxTrackingId) !== normalizeTrackingNumber(number)) {
    throw new IndeterminateError(PROVIDER, 'AQX Logistics answered for another shipment');
  }
  if (shipment.events !== null && shipment.events !== undefined && !Array.isArray(shipment.events)) return invalid('AQX Logistics returned invalid events');
  const rows = (shipment.events ?? []) as unknown[];
  if (rows.length > MAX_EVENTS) return invalid('AQX Logistics returned too many events');
  // Newest first; events at one instant keep the reply's order, oldest first.
  const events: CarrierEvent[] = rows.map(eventOf).sort((a, b) => b.at - a.at || b.index - a.index).map(({ event }) => event);
  const service = text(shipment.serviceTier, 80, 'service');
  const countryName = text(shipment.destinationCountry, 60, 'destination');
  const country = countryName ? countryCode(countryName) : null;
  const weight = shipment.totalWeightKg;
  if (weight !== null && weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) {
    return invalid('AQX Logistics returned an invalid weight');
  }
  const facts = {
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : countryName ? { destination_country_name: countryName } : {}),
    ...(typeof weight === 'number' && weight > 0 ? { weight_kg: Math.round(weight * 1000) / 1000 } : {}),
  };
  const wording = text(shipment.status, 80, 'status');
  const summary = wording ? aqxStage(wording) : null;
  const newest = events[0];
  if (!newest) {
    if (!summary) throw new NoHistoryError(PROVIDER, 'AQX Logistics lists the shipment without a status it can read', { reason: 'listed' });
    return {
      status: languageStageStatus(summary.stage), current_stage: summary.stage, current_stage_source: summary.source,
      last_status_text: wording, last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [],
    };
  }
  // The shipment's status is its current one, and it can be ahead of the events, as a delivered
  // shipment with only its registration event shows: then it leads, without a time.
  const lead = leadingScan(events, statusMap);
  if (summary && summary.stage !== lead?.stage) {
    return {
      status: languageStageStatus(summary.stage), current_stage: summary.stage, current_stage_source: summary.source,
      last_status_text: wording, last_update: null, expected_delivery: null, ...facts, events,
    };
  }
  const stage = lead?.stage as Parameters<typeof languageStageStatus>[0] | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...facts,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function aqxJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isAqxBlocked(body)) throw new ChallengeError(PROVIDER, 'AQX Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'AQX Logistics returned a reply that is not JSON', { cause });
  }
}
