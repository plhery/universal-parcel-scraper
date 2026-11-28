import { DateTime, FixedOffsetZone } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { zimpostStage } from './status.js';

export const PROVIDER = 'Zimpost';
// A long IPS history is a few dozen kilobytes.
export const ZIMPOST_MAX_BYTES = 512 * 1024;

const MAX_SCANS = 500;
// IPS's GMT clock, to the second or the millisecond.
const GMT_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z?$/;
const CODE = /^\d{1,4}$/;
// The only reply the tracker gives an item IPS does not hold, with HTTP 404.
const NOT_FOUND = /^tracking number not found$/i;
// A firewall's, CDN's or bot check's page in place of the reply, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;

/**
 * A number for Zimpost's tracker: a UPU S10 code with a valid check digit,
 * Zimpost's own or that of a post sending the item to Zimbabwe.
 */
export function normalizeZimpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Zimpost tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Zimpost returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The offset IPS states in hours, in minutes; null when no clock can have it. */
function offsetMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const minutes = value * 60;
  return Number.isInteger(minutes) && minutes % 15 === 0 && minutes >= -12 * 60 && minutes <= 14 * 60 ? minutes : null;
}

/**
 * A scan's instant: IPS's GMT clock, written with the offset in hours IPS
 * states beside it. Without an offset a clock can have, the instant stays in
 * UTC: the GMT clock is the instant whatever the offset says.
 */
function instantOf(row: Record<string, unknown>): string {
  const [, clock, fraction = ''] = GMT_CLOCK.exec(text(row, 'EVENT_GMT_DATETIME', 40)) ?? [];
  const parsed = clock ? DateTime.fromISO(clock + fraction, { zone: 'UTC' }) : null;
  if (!clock || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== clock || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'Zimpost returned an invalid scan time');
  }
  const minutes = offsetMinutes(row.EVENT_LOCAL_OFFSET);
  const zoned = minutes === null ? parsed : parsed.setZone(FixedOffsetZone.instance(minutes));
  return zoned.toISO({ suppressMilliseconds: true })!;
}

interface Scan { event: CarrierEvent; millis: number; index: number }

/**
 * One IPS event: its number, IPS's English name, the office that recorded it
 * and its instant. The next office, the bag state and the item's condition
 * are not read.
 */
function scanOf(row: unknown, position: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Zimpost returned an invalid scan');
  const rawCode = row.EVENT_TYPE_CODE;
  if (rawCode !== null && rawCode !== undefined && typeof rawCode !== 'string' && typeof rawCode !== 'number') {
    throw new SchemaError(PROVIDER, 'Zimpost returned an invalid event code');
  }
  const code = rawCode === null || rawCode === undefined ? '' : String(rawCode).trim();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Zimpost returned an invalid event code');
  const description = text(row, 'EVENT_TYPE', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Zimpost returned a scan without wording');
  const time = instantOf(row);
  const location = text(row, 'EVENT_OFFICE', 120);
  const staged = zimpostStage(code || null, description);
  const index = typeof row.EVENT_INDEX === 'number' && Number.isInteger(row.EVENT_INDEX) ? row.EVENT_INDEX : position;
  return {
    event: {
      time,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    millis: DateTime.fromISO(time).toMillis(),
    index,
  };
}

/**
 * The `data` of a found reply: the tracker's summary of the item, and under
 * `raw.data` the IPS record it relays, with `MAILITM_FID` and the events
 * oldest first. The item must be the whole code asked for.
 */
export function parseZimpost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeZimpostNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Zimpost returned an invalid reply');
  if (payload.type !== 'ips') throw new SchemaError(PROVIDER, 'Zimpost answered from a source the adapter does not read');
  const relay = isRecord(payload.raw) ? payload.raw : undefined;
  const item = relay && isRecord(relay.data) ? relay.data : undefined;
  if (!item || typeof item.MAILITM_FID !== 'string') throw new SchemaError(PROVIDER, 'Zimpost omitted the IPS record');
  const names = [item.MAILITM_FID, payload.trackingNumber, relay!.fid].filter((value): value is string => typeof value === 'string');
  if (names.some(name => normalizeTrackingNumber(clean(name, 64)) !== number)) {
    throw new IndeterminateError(PROVIDER, 'Zimpost answered for another item');
  }
  const rows = item.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Zimpost returned an item with invalid scans');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Zimpost returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, position) => {
    const scan = scanOf(row, position);
    // An event the record lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; events of one instant keep IPS's order, the later one first.
  scans.sort((left, right) => right.millis - left.millis || right.index - left.index);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const weight = item.MAILITM_WEIGHT_KG;
  const destinationName = typeof item.DEST_COUNTRY === 'string' ? clean(item.DEST_COUNTRY, 80) : '';
  const destination = countryCode(destinationName);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? { weight_kg: weight } : {}),
    ...(destination ? { destination_country: destination } : destinationName ? { destination_country_name: destinationName } : {}),
    events,
  };
}

/**
 * The tracker's reply to `GET /api/track?number=`, by its HTTP status: 200
 * with `success` and the item's `data`, or 404 with `success: false` and the
 * error "Tracking number not found", the only reply read as not found. Any
 * other 404 is a missing route, not a missing item.
 */
export function parseZimpostReply(status: number, body: string, rawNumber: string): CarrierResult {
  const number = normalizeZimpostNumber(rawNumber);
  // Trimming also drops a byte order mark.
  const textBody = body.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(textBody);
  } catch (cause) {
    if (BLOCKED.test(textBody.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Zimpost answered with a block page', { cause, status });
    if (status === 404) throw new TransportError(PROVIDER, 'Zimpost’s tracking lookup is unavailable', { cause, status });
    throw new SchemaError(PROVIDER, 'Zimpost returned a reply that is not JSON', { cause });
  }
  if (!isRecord(payload) || typeof payload.success !== 'boolean') {
    if (status === 404) throw new TransportError(PROVIDER, 'Zimpost’s tracking lookup is unavailable', { status });
    throw new SchemaError(PROVIDER, 'Zimpost returned an invalid reply');
  }
  if (status === 404) {
    if (!payload.success && typeof payload.error === 'string' && NOT_FOUND.test(payload.error.trim())) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Zimpost returned an unknown error');
  }
  if (!payload.success) throw new SchemaError(PROVIDER, 'Zimpost returned an unknown error');
  return parseZimpost(payload.data, number);
}
