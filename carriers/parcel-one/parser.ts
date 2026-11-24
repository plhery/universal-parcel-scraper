import { load } from 'cheerio';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { parcelOneProgress, parcelOneStage, statusMap } from './status.js';

export const PROVIDER = 'PARCEL.ONE';
export const CARRIER = 'parcel-one';
// A parcel with ten scans is about 3 kB.
export const PARCEL_ONE_MAX_BYTES = 256 * 1024;

// PARCEL.ONE's own thirteen digits, or the delivery carrier's number, which the tracker also finds.
const NUMBER = /^[A-Z0-9]{6,40}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
// "2026-07-17 08:57": a wall clock with no zone, to the minute.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
// The tracker's answer for a number it holds nothing for, whatever postcode came with it.
const NOT_FOUND = /^No data could be found for the entered Tracking Number and Receiver ZIP Code!?$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_SCANS = 300;

/** A number for PARCEL.ONE's tracker: letters and digits, in capitals. */
export function normalizeParcelOneNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PARCEL.ONE looks parcels up by 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isParcelOneBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('PARCEL.ONE returned an invalid field');
  return clean(value, max);
}

/** A scan's wording, which can hold a link to the delivery carrier's tracker: its text alone. */
function wording(value: unknown): string {
  const raw = text(value, 2000);
  return raw.includes('<') ? clean(load(raw.replace(/<br\s*\/?>/gi, ' '), null, false).text(), 500) : raw;
}

/** A scan's date and time as one wall time, calendar-checked. The reply names no zone. */
function wallClock(value: unknown): string {
  const parts = CLOCK.exec(text(value, 40));
  const day = parts && calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!parts || !day || Number(parts[1]) < 2000 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
    return invalid('PARCEL.ONE returned an invalid scan time');
  }
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

function scan(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('PARCEL.ONE returned an invalid scan');
  const description = wording(row.status) || invalid('PARCEL.ONE returned a scan without its wording');
  const location = text(row.location, 120);
  const staged = parcelOneStage(description);
  return {
    local_time: wallClock(row.date),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The address of the first link in the logo the tracker gives the delivery carrier. */
function logoLink(html: string): string {
  return html ? clean(load(html, null, false)('a[href]').first().attr('href'), 500) : '';
}

/**
 * Whether the number has the partner's shape: one of the partner's detection
 * rules offers it, or the partner's own tracking link in the reply opens it.
 */
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as readonly string[]).includes(partner)) return true;
  const linked = parseTrackingInput(link);
  return linked.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/**
 * The delivery carrier and its number, from the reply's partner block. The
 * carrier is named when the block's tracking link, else its logo's link, is one
 * catalog carrier's and the number has that carrier's shape; the number stays
 * without a carrier otherwise. The link is never followed.
 */
function partner(value: unknown, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) return invalid('PARCEL.ONE returned an invalid delivery carrier');
  const reference = normalizeTrackingNumber(text(value.trackingNumber, 64)).toUpperCase();
  if (!REFERENCE.test(reference)) return {};
  const link = text(value.trackingUrl, 500) || logoLink(text(value.logoHtml, 2000));
  const carrier = link ? carrierIdFromPartner('', link) : undefined;
  const named = carrier && carrier !== CARRIER && partnerShape(carrier, reference, link) ? carrier : undefined;
  return {
    ...(named ? { delivery_carrier: named } : {}),
    // A parcel asked by the delivery carrier's number has no second reference.
    ...(reference === number ? {} : { delivery_tracking_number: reference }),
  };
}

/** Newest first, as the tracker lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events.length > 1 && (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
}

/**
 * The reply of `parcel.one/wp-json/parcelone/v1/track` for one number, the
 * lookup PARCEL.ONE's tracking page makes. It repeats the number asked, says
 * whether it found a parcel, and gives the progress code of the page's five
 * steps, the delivery carrier's number with a link to its tracker, and the
 * scans newest first, each with a wall clock to the minute, a wording and a
 * place. A number it holds nothing for gets `found: false` with a message.
 *
 * The recipient's name and address, which the tracker gives only with their
 * postcode, are never read, nor the postcode it repeats.
 */
export function parseParcelOne(payload: unknown, raw: string): CarrierResult {
  const number = normalizeParcelOneNumber(raw);
  if (!isRecord(payload) || typeof payload.found !== 'boolean' || typeof payload.trackingNumber !== 'string') {
    return invalid('PARCEL.ONE returned an unexpected reply');
  }
  // The reply repeats the number it searched for, as it was sent.
  if (normalizeTrackingNumber(payload.trackingNumber).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'PARCEL.ONE answered for another number');
  }
  if (payload.events !== undefined && payload.events !== null && !Array.isArray(payload.events)) {
    return invalid('PARCEL.ONE returned an invalid history');
  }
  const rows = (payload.events ?? []) as unknown[];
  if (!payload.found) {
    if (NOT_FOUND.test(text(payload.error, 300)) && !rows.length && (payload.carrier === null || payload.carrier === undefined)) throw new NotFoundError(PROVIDER);
    // Another message, or a parcel's details beside it, says nothing about the number.
    throw new IndeterminateError(PROVIDER, 'PARCEL.ONE did not complete the lookup');
  }
  if (rows.length > MAX_SCANS) return invalid('PARCEL.ONE returned too many scans');
  const handoff = partner(payload.carrier, number);
  const code = text(payload.trackingProgress, 40);
  const progress = code ? parcelOneProgress(code) : undefined;
  const events = newestFirst(rows.map(scan));
  const newest = events[0];
  if (!newest) {
    // A parcel without scans stands on its progress code alone, when the page names it.
    if (!progress) {
      throw new NoHistoryError(PROVIDER, undefined, { deliveryCarrier: handoff.delivery_carrier, deliveryTrackingNumber: handoff.delivery_tracking_number });
    }
    return {
      status: languageStageStatus(progress.stage), current_stage: progress.stage, current_stage_source: 'carrier_map',
      provider_code: code, last_status_text: progress.label, last_update: null, expected_delivery: null,
      ...handoff, summary_only: true, events: [],
    };
  }
  // The newest scan with a stage leads; the progress code stands in when no scan has one.
  const lead = leadingScan(events, statusMap);
  const stage = (lead?.stage ?? progress?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...handoff,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function parcelOneJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isParcelOneBlocked(body)) throw new ChallengeError(PROVIDER, 'PARCEL.ONE answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'PARCEL.ONE returned a reply that is not JSON', { cause });
  }
}
