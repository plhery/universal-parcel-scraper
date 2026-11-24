import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { calendarDay, countryCode, countryKeepsOffset } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { clean } from '../../core/transport/index.js';
import { emiratesCourierStage, statusMap } from './status.js';

export const PROVIDER = 'emirates-courier-express';
// A parcel with twenty scans is about 16 kB.
export const EMIRATES_COURIER_MAX_BYTES = 1024 * 1024;

const NUMBER = /^\d{12}$/;
const MAX_SCANS = 300;
// "2026-04-13T14:57:00", sometimes with a fraction of a second: the clock where the scan happened.
const WALL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,7}))?)?$/;
// A scan's code, and the piece's reason for an exception.
const CODE = /^[A-Z]{3}$/;
const REASON = /^[A-Z0-9]{2,6}$/;
// The carrier's own depots, which the scans name before the town.
const OWN_DEPOT = /^emirates courier express$/i;
const QUARTER_HOUR_MS = 15 * 60_000;

/** A number for the tracker: its twelve digits, without the spaces or dashes a label may print. */
export function normalizeEmiratesCourierNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the twelve-digit Emirates Courier Express tracking number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const empty = (value: unknown) => value === null || value === undefined;

/** An optional text field, single-spaced. */
function text(value: unknown, max: number): string | undefined {
  if (empty(value)) return undefined;
  if (typeof value !== 'string' || value.length > max) return invalid('Emirates Courier Express returned an invalid field');
  return clean(value, max) || undefined;
}

/** The scan's wall clock, calendar-checked, to the second, and its reading as if it were UTC. */
function wallClock(value: unknown): { wall: string; asUtc: number } {
  const match = typeof value === 'string' ? WALL.exec(value) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) return invalid('Emirates Courier Express returned an invalid scan time');
  const seconds = match[6] ?? '00';
  const fraction = Number(`0.${match[7] ?? '0'}`);
  return { wall: `${day}T${match[4]}:${match[5]}:${seconds}`,
    asUtc: Date.parse(`${day}T${match[4]}:${match[5]}:${seconds}Z`) + Math.round(fraction * 1000) };
}

/** The UTC instant the reply gives beside the wall clock; null when it gives none. */
function utcInstant(value: unknown): number | null {
  if (empty(value)) return null;
  const parsed = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!parsed?.isValid) return invalid('Emirates Courier Express returned an invalid UTC time');
  return parsed.toMillis();
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/**
 * The offset the reply states for a scan: its UTC instant read against its wall clock, when the
 * two agree to the second on a whole quarter hour that a civil clock keeps, in the scan's
 * country when the location names one. A courier's scan agrees so. A flight's departure or
 * arrival carries the time the message was written, minutes after the wall clock, and gets none.
 */
function statedOffset(asUtc: number, instant: number | null, country: string | null): string | undefined {
  if (instant === null) return undefined;
  const minutes = Math.round((asUtc - instant) / QUARTER_HOUR_MS) * 15;
  if (Math.abs(asUtc - instant - minutes * 60_000) >= 1000) return undefined;
  if (minutes < -12 * 60 || minutes > 14 * 60 || ![0, 30, 45].includes(Math.abs(minutes) % 60)) return undefined;
  const offset = offsetText(minutes);
  return country && countryKeepsOffset(country, offset) === false ? undefined : offset;
}

/** The scan's code: the milestone's, joined with the piece's reason when the milestone is an exception group. */
function codeOf(scan: Record<string, unknown>): string | undefined {
  const code = text(scan.descriptionCode, 8);
  if (!code) return undefined;
  if (!CODE.test(code)) return invalid('Emirates Courier Express returned an invalid scan code');
  const reason = code.endsWith('X') && isRecord(scan.piece) ? text(scan.piece.pieceException, 8) : undefined;
  if (reason && !REASON.test(reason)) return invalid('Emirates Courier Express returned an invalid exception code');
  return reason ? `${code}${reason}` : code;
}

/** The scan's place without the carrier's own name before it, and the country it ends with. */
function placeOf(value: unknown): { location?: string; country: string | null } {
  const parts = (text(value, 200) ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  const place = parts.length > 1 && OWN_DEPOT.test(parts[0]!) ? parts.slice(1) : parts;
  return { ...(place.length ? { location: place.join(', ') } : {}), country: place.length > 1 ? countryCode(place.at(-1)) : null };
}

function scanOf(scan: unknown): CarrierEvent {
  if (!isRecord(scan)) return invalid('Emirates Courier Express returned an invalid scan');
  const description = text(scan.description, 200) ?? invalid('Emirates Courier Express returned a scan without its wording');
  const code = codeOf(scan);
  const { location, country } = placeOf(scan.currentCountry);
  const { wall, asUtc } = wallClock(scan.d);
  const offset = statedOffset(asUtc, utcInstant(scan.eventUtc), country);
  const mapped = emiratesCourierStage(code ?? null);
  const notice = statusGapNote(statusMap, code ?? null, normalizeStatusWording(description)) !== undefined;
  const worded = mapped || notice ? undefined : classifyWording(description, 'in_transit');
  const staged = mapped ? { stage: mapped, stage_source: 'carrier_map' }
    : worded && worded.source !== 'none' ? { stage: worded.stage, stage_source: worded.source } : {};
  return {
    ...(offset ? { time: `${wall}${offset}` } : { local_time: wall }),
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...staged,
  };
}

/** The awb numbers the reply repeats, on its pieces and on each scan's piece. */
function namedNumbers(details: unknown[], pieces: unknown[]): string[] {
  const named = [...pieces, ...details.map((scan) => (isRecord(scan) ? scan.piece : undefined))]
    .map((piece) => (isRecord(piece) ? piece.awbnumber : undefined)).filter((value) => !empty(value));
  return named.map((value) => (typeof value === 'string' && value.length <= 40 ? normalizeTrackingNumber(value)
    : invalid('Emirates Courier Express returned an invalid tracking number')));
}

/**
 * The tracker's details for one number: the scans newest first, each on the clock where it
 * happened, with the parcel's origin and destination. A number it holds nothing for gets every
 * field empty, without the number, which the request alone binds. The delivery estimate is not
 * read: a delivered parcel's is a day after the request. The proof of delivery's links and the
 * origin town are left out.
 */
export function parseEmiratesCourier(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeEmiratesCourierNumber(rawNumber);
  if (!isRecord(payload) || !('details' in payload) || !('pieces' in payload)) return invalid('Emirates Courier Express returned an unreadable reply');
  const { details, pieces } = payload;
  if ((details !== null && !Array.isArray(details)) || (pieces !== null && !Array.isArray(pieces))) {
    return invalid('Emirates Courier Express returned an unreadable reply');
  }
  const scans = details ?? [];
  if (scans.length === 0) {
    if ((pieces ?? []).length === 0 && empty(payload.origin) && empty(payload.destination)) {
      throw new NotFoundError(PROVIDER, 'Emirates Courier Express has no shipment under this number');
    }
    return invalid('Emirates Courier Express returned a shipment without scans');
  }
  if (scans.length > MAX_SCANS) return invalid('Emirates Courier Express returned too many scans');
  const named = namedNumbers(scans, pieces ?? []);
  if (named.some((value) => value !== number)) throw new IndeterminateError(PROVIDER, 'Emirates Courier Express answered for another number');
  if (named.length === 0) return invalid('Emirates Courier Express returned scans without the tracking number');

  // A flight's arrival can be listed once per message about it; the scan is kept once.
  const seen = new Set<string>();
  const events = scans.map(scanOf).filter((event) => {
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  const destination = text(payload.destination, 120)?.split(',').at(-1)?.trim();
  const country = destination ? countryCode(destination) : null;
  const delivered = stage === 'delivered' ? current?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time! }),
    expected_delivery: null,
    ...(stage === 'delivered' || stage === 'returned' ? {}
      : unreadEstimates({ estimatedDelivery: payload.estimatedDelivery, estimatedDeliveryDate: payload.estimatedDeliveryDate })),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
