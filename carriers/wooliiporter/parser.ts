import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasLuhnCheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { WOOLII_LABELS, wooliiStage } from './status.js';

export const PROVIDER = 'WooliiPorter';
// A shipment's reply is a few kilobytes.
export const WOOLII_MAX_BYTES = 256 * 1024;
// WP and thirteen digits, the last a Luhn check digit of the twelve before it, as the page checks.
const PUBLIC_NUMBER = /^WP(\d{13})$/;
// A WPTRK- reference, which the page also takes; the hyphen is dropped when a number is normalized.
const REFERENCE = /^WPTRK-?([A-Z0-9]{1,80})$/;
// A scan's instant as an ISO date and time with its offset, as the page passes it to Date.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MAX_ROWS = 500;

/** The number as the page asks it: WP and thirteen digits with a valid check digit, or a WPTRK- reference. */
export function normalizeWooliiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 100 ? normalizeTrackingNumber(raw) : '';
  const digits = PUBLIC_NUMBER.exec(number)?.[1];
  if (digits && hasLuhnCheckDigit(digits)) return number;
  const reference = REFERENCE.exec(number)?.[1];
  if (reference) return `WPTRK-${reference}`;
  throw new InvalidInputError(PROVIDER, 'WooliiPorter numbers are WP and thirteen digits with a valid check digit, or WPTRK- references');
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`WooliiPorter returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's instant in the offset the reply gives it. Date libraries accept hour 24, so the fields are checked here. */
function instant(value: string): string {
  const match = INSTANT.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) invalid('WooliiPorter returned an invalid scan time');
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) invalid('WooliiPorter returned an invalid scan time');
  const iso = parsed.startOf('second').toISO({ suppressMilliseconds: true });
  const fraction = /\.(\d+)/.exec(value)?.[1]?.replace(/0+$/, '');
  return fraction ? iso.slice(0, 19) + '.' + fraction.padEnd(3, '0') + iso.slice(19) : iso;
}

/** One scan: its instant, English wording, place and status code. */
function scan(row: unknown): CarrierEvent {
  if (!isRecord(row)) invalid('WooliiPorter returned an invalid scan');
  const code = text(row, 'status', 40).toUpperCase();
  const time = instant(text(row, 'eventAt', 40));
  const description = text(row, 'descriptionEn', 500) || WOOLII_LABELS.get(code) || '';
  if (!description) invalid('WooliiPorter returned a scan without its wording');
  const location = text(row, 'location', 200);
  const stage = code ? wooliiStage(code) : undefined;
  return {
    time, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

/**
 * The reply of `/api/public/tracking/{number}`: the shipment's public number, its carrier's
 * name, its status code and its scans. The reply must name the number asked; for a WPTRK-
 * reference it may name the shipment's WP number instead, which the page then shows. A
 * shipment without scans has been created but not yet scanned. The carrier's name is not read.
 */
export function parseWoolii(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWooliiNumber(raw);
  if (!isRecord(payload) || typeof payload.trackingNumber !== 'string' || !Array.isArray(payload.events)) {
    invalid('WooliiPorter returned an invalid tracking reply');
  }
  const named = normalizeTrackingNumber(clean(payload.trackingNumber, 100));
  const canonical = number.startsWith('WPTRK-') && PUBLIC_NUMBER.test(named) ? named : '';
  if (named !== normalizeTrackingNumber(number) && !canonical) throw new IndeterminateError(PROVIDER, 'WooliiPorter answered for another shipment');
  const rows: unknown[] = payload.events;
  if (rows.length > MAX_ROWS) invalid('WooliiPorter returned an oversized history');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'WooliiPorter has created the shipment but has no scan yet', { reason: 'listed' });

  const seen = new Set<string>();
  const events = rows.map(scan).filter((event) => {
    const key = JSON.stringify([event.time, event.provider_code, event.description, event.location]);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  // Newest first by the instant; scans at one instant keep the reply's order.
  const nanos = (time: string) => Number((/\.(\d+)/.exec(time)?.[1] ?? '').padEnd(9, '0'));
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!) || nanos(b.time!) - nanos(a.time!));
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(stage === 'delivered' ? { delivered_at: current!.time } : {}),
    expected_delivery: null,
    ...(canonical ? { canonical_tracking_number: canonical } : {}),
    events,
  };
}
