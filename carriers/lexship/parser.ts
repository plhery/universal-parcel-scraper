import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lexshipStage } from './status.js';

export const PROVIDER = 'lexship';
// A delivered shipment's reply is under two kilobytes.
export const LEXSHIP_MAX_BYTES = 256 * 1024;

// The tracker takes a shipment number as free text; its shipments carry postal and partner numbers.
const NUMBER = /^[A-Z0-9]{6,30}$/;
const DAY = /^\d{2}\/\d{2}\/\d{4}$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
// The lookup's answer for a number it holds no shipment for, as "aAWB Not Found".
const NOT_FOUND = /^a?AWB Not Found$/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_ROWS = 300;

/** The number as the tracker takes it, without spaces or dashes and in capitals. */
export function normalizeLexshipNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid LEXSHIP shipment number');
  return number;
}

export function isLexshipBlocked(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

export function lexshipJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isLexshipBlocked(body)) throw new ChallengeError(PROVIDER, 'LEXSHIP answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'LEXSHIP returned a reply that is not JSON', { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `LEXSHIP returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `ActionDate` and `ActionTime`, as "28/09/2024" and "12:58:28". The reply names no
 * zone, and its later scans come from transit hubs and the destination country, so the clock
 * stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const day = text(row, 'ActionDate', 16);
  const time = text(row, 'ActionTime', 12);
  // Parsing in UTC checks the calendar only; the wall clock keeps no offset.
  const parsed = DAY.test(day) && CLOCK.test(time)
    ? DateTime.fromFormat(`${day} ${time}`, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' }) : undefined;
  if (!parsed?.isValid || parsed.toFormat('HH:mm:ss') !== time) throw new SchemaError(PROVIDER, 'LEXSHIP returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function sequence(row: Record<string, unknown>): number | undefined {
  const value = row.SNo;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function scan(row: unknown): { order: number | undefined; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'LEXSHIP returned an invalid scan');
  const description = text(row, 'Status', 300);
  if (!description) throw new SchemaError(PROVIDER, 'LEXSHIP returned a scan without a status');
  const staged = lexshipStage(description);
  return {
    order: sequence(row),
    event: {
      local_time: scanClock(row),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

function country(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country'> {
  const code = text(shipment, 'Destination', 8).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? { destination_country: code } : {};
}

/**
 * The reply of `POST /api/tracking/new` on live1.lexship.com, the lookup LEXSHIP's tracking page
 * makes for each number: a list with one entry per number asked. A found entry gives the
 * shipment's status, its origin and destination countries and cities, and its scans in
 * `TrackPoints.AWBHistory`, numbered in `SNo` from the booking. An unknown number gets an entry
 * whose status is "aAWB Not Found" and whose history is empty. The entry must be the number asked.
 * The consignee's name, the cities and the ship date are not read.
 */
export function parseLexship(reply: unknown, number: string): CarrierResult {
  if (!Array.isArray(reply)) throw new SchemaError(PROVIDER, 'LEXSHIP returned an invalid envelope');
  // The page reads an empty list as no data from the tracker, never as a missing shipment.
  if (!reply.length) throw new IndeterminateError(PROVIDER, 'LEXSHIP returned no entry for the number');
  const shipment = (reply as unknown[]).find((entry) => isRecord(entry) && normalizeTrackingNumber(text(entry, 'AWBNo', 64)) === number);
  if (!isRecord(shipment)) throw new IndeterminateError(PROVIDER, 'LEXSHIP answered for another shipment');
  const status = text(shipment, 'Status', 200);
  const points = shipment.TrackPoints;
  if (!isRecord(points)) {
    if (NOT_FOUND.test(status)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'LEXSHIP returned an entry without its history');
  }
  // An unknown number's history is a list holding one empty list.
  const history: unknown = points.AWBHistory;
  const rows = Array.isArray(history) ? (history as unknown[]).filter((row) => !(Array.isArray(row) && !row.length)) : undefined;
  if (!rows || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'LEXSHIP returned invalid scans');
  if (NOT_FOUND.test(status)) {
    if (rows.length) throw new IndeterminateError(PROVIDER, 'LEXSHIP listed scans for a shipment it does not find');
    throw new NotFoundError(PROVIDER);
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const scans = rows.map(scan);
  // Newest first: by wall clock, then by the reply's scan number, as the page lists them.
  scans.sort((left, right) => {
    const a = left.event.local_time as string;
    const b = right.event.local_time as string;
    if (a !== b) return a < b ? 1 : -1;
    return (right.order ?? 0) - (left.order ?? 0);
  });
  const events = scans.map((entry) => entry.event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    ...country(shipment),
    events,
  };
}
