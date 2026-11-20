import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { acplCargoBookingDelivered, acplCargoStage } from './status.js';

export const PROVIDER = 'acpl-cargo';
// A delivered GC with ten movements is under two kilobytes.
export const MAX_BYTES = 256_000;
// ACPL's branches are all in India, which keeps one clock.
const ZONE = 'Asia/Kolkata';
const MAX_ROWS = 300;
const NUMBER = /^\d{10}$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// The key the tracker answers with, set to FAIL, for a GC number it does not hold.
const INVALID_KEY = 'documentnonotvalid';

/** A GC number as the tracker's form takes it: ten digits, as its example. */
export function normalizeAcplCargoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter an ACPL Cargo GC number: ten digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Whether a row names the GC number invalid. */
const refused = (row: Record<string, unknown>) => Object.entries(row)
  .some(([key, value]) => key.toLowerCase() === INVALID_KEY && typeof value === 'string' && value.trim().toUpperCase() === 'FAIL');

/** A row that holds nothing but the invalid-number flag, or nothing at all, as the tracker's script reads it. */
const errorOnly = (row: Record<string, unknown>) => Object.entries(row)
  .filter(([, value]) => value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== ''))
  .every(([key]) => key.toLowerCase() === INVALID_KEY);

function rows(value: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return invalid(`ACPL Cargo returned no ${what}`);
  if (value.length > MAX_ROWS) return invalid(`ACPL Cargo returned too many ${what}`);
  return value.map((row) => isRecord(row) ? row : invalid(`ACPL Cargo returned an unreadable ${what} row`));
}

type Movement = CarrierEvent & { time: string; description: string };

function movement(row: Record<string, unknown>): Movement {
  const digits = CLOCK.exec(clean(row.date));
  const status = clean(row.status, 120);
  if (!digits || !status) return invalid('ACPL Cargo returned an unreadable movement');
  const [, year, month, day, hour, minute, second] = digits;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  // Luxon rolls an impossible clock over, so only one that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  const time = isoTime(wall, ZONE);
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall || Number(year) < 2001 || Number(year) > 2100 || !time) {
    return invalid('ACPL Cargo returned an unreadable movement');
  }
  const location = clean(row.location, 120);
  const stage = acplCargoStage(status);
  return { time: time.iso, time_zone: ZONE, time_zone_basis: 'carrier', description: status,
    ...(location ? { location } : {}), provider_code: status, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/** A DD/MM/YYYY day as `YYYY-MM-DD`, or null when there is none. */
function dayOf(value: unknown): string | null {
  const text = clean(value, 32);
  if (!text) return null;
  const digits = DAY.exec(text);
  return (digits && calendarDay(Number(digits[3]), Number(digits[2]), Number(digits[1]))) || invalid('ACPL Cargo returned an unreadable day');
}

/** Reads the tracker's reply for a GC number: its booking, and the movements of its consignment. */
export function parseAcplCargo(body: unknown, number: string): CarrierResult {
  if (!isRecord(body)) return invalid('ACPL Cargo returned an invalid reply');
  if (refused(body)) throw new NotFoundError(PROVIDER);
  const master = rows(body.etransBookingMaster, 'bookings');
  const details = rows(body.etransBookingDetails, 'booking details');
  const dispatch = rows(body.etransDispatchDetails, 'movements');
  if (master.length && master.every(errorOnly)) {
    if (master.some(refused)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'ACPL Cargo answered without a booking or a reason');
  }
  const bookings = master.filter((row) => !errorOnly(row) && clean(row.docketNo));
  // The tracker's page says it found nothing, but the reply does not call the number unknown.
  if (!bookings.length) throw new IndeterminateError(PROVIDER, 'ACPL Cargo found no booking for the GC number');
  if (bookings.some((row) => clean(row.docketNo) !== number)) throw new IndeterminateError(PROVIDER, 'ACPL Cargo answered for another GC number');
  if (details.some((row) => !errorOnly(row) && clean(row.gcno) !== number)) {
    throw new IndeterminateError(PROVIDER, 'ACPL Cargo answered for another GC number');
  }
  const booking = bookings[0]!;

  // The reply lists the movements oldest first.
  const seen = new Set<string>();
  const events = dispatch.map(movement).map((event, index) => ({ event, index })).filter(({ event }) => {
    const key = JSON.stringify([event.time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.time.localeCompare(a.event.time) || b.index - a.index).map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'ACPL Cargo lists the GC without movements', { reason: 'listed' });

  // The booking's status, which the page shows over the movements, settles a delivery they do not show.
  const bookingStatus = clean(booking.status, 80);
  const scanned = events.find((event) => event.stage);
  const summary: Stage | undefined = acplCargoBookingDelivered(bookingStatus) ? 'delivered' : undefined;
  const stage = summary ?? scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: stage === 'delivered' ? null : dayOf(booking.expectedDate),
    ...(delivered ? { delivered_at: delivered.time } : {}),
    timezone: ZONE,
    events,
  };
}
