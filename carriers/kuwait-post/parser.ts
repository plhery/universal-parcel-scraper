import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kuwaitPostStage, statusMap } from './status.js';

export const PROVIDER = 'Kuwait Post';
// The browser helper's reading of a reply: about 400 bytes a scan, at most 301 scans.
export const MAX_BYTES = 200_000;
const MAX_EVENTS = 300;
// "2017-09-06 10:13:36.070": the office's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?$/;
// An inward scan, in the country the item was sent to.
const INWARD = /\(inb\)$/i;
// The details that are kept: why an item was not delivered, what happens next and why it is held.
const DETAILS = ['NON_DELIVERY_REASON_NM', 'NON_DELIVERY_MEASURE_NM', 'RETENTION_REASON_NM'] as const;
// The longest wait the tracker's refusal is taken at.
const MAX_RETRY_MS = 60 * 60 * 1000;

/**
 * The tracker looks up UPU S10 item codes in IPS: Kuwait Post's own and those of the posts that
 * send mail to Kuwait. The code needs a valid check digit.
 */
export function normalizeKuwaitPostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Kuwait Post tracks S10 item codes');
}

/** A scan's wall clock, calendar-checked. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Kuwait Post returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

interface Scan { event: CarrierEvent; country: string | null; wording: string }

function scanOf(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Kuwait Post returned an invalid scan');
  const wording = clean(row.EVENT_TYPE_NM, 200) || clean(row.DEFAULT_EVENT_TYPE_NM, 200);
  if (!wording) throw new SchemaError(PROVIDER, 'Kuwait Post returned a scan without wording');
  // IPS writes some countries' names in ISO's style, "Netherlands (the)".
  const countryName = clean(row.COUNTRY_NM, 80).replace(/\s*\(the\)$/i, '');
  const office = clean(row.LOCATION, 120);
  // The office, then its country, which a scan can name alone.
  const location = office.toLowerCase() === countryName.toLowerCase() ? countryName : [office, countryName].filter(Boolean).join(', ');
  const details = DETAILS.map(key => clean(row[key], 120)).filter(Boolean);
  const staged = kuwaitPostStage(wording);
  const event: CarrierEvent = {
    local_time: wallClock(row.EVENT_LOCAL_DT),
    ...(location ? { location } : {}),
    description: details.length ? `${wording}: ${details.join('; ')}` : wording,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, country: countryCode(row.COUNTRY) ?? countryCode(countryName), wording };
}

/**
 * The browser helper's reading of the form's server action: its outcome and, for an item the
 * tracker holds, every scan IPS has for it, the origin post's included, oldest first. The
 * reply does not repeat the item code; the helper binds it to the one request that sent it.
 */
export function parseKuwaitPost(data: unknown, raw: string): CarrierResult {
  normalizeKuwaitPostNumber(raw);
  if (!isRecord(data) || typeof data.success !== 'boolean') throw new SchemaError(PROVIDER, 'Kuwait Post returned an invalid reply');
  if (!data.success) {
    switch (data.message) {
      case 'no_data_found': throw new NotFoundError(PROVIDER);
      case 'captcha_invalid': throw new ChallengeError(PROVIDER, 'Kuwait Post refused its reCAPTCHA answer');
      case 'rate_limit_exceeded': {
        const seconds = data.retryAfterSeconds;
        throw new RateLimitedError(PROVIDER, typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
          ? Math.min(MAX_RETRY_MS, Math.ceil(seconds * 1000)) : undefined);
      }
      case 'tracking_unavailable': throw new TransportError(PROVIDER, 'Kuwait Post tracking is unavailable');
      default: throw new SchemaError(PROVIDER, 'Kuwait Post returned an unexpected refusal');
    }
  }
  if (!Array.isArray(data.data)) throw new SchemaError(PROVIDER, 'Kuwait Post returned an invalid history');
  if (!data.data.length) throw new NoHistoryError(PROVIDER);
  if (data.data.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Kuwait Post returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  // Newest first; scans on the same clock keep the tracker's order, reversed.
  for (const scan of data.data.map(scanOf).reverse()) {
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  scans.sort((a, b) => b.event.local_time!.localeCompare(a.event.local_time!));
  const events = scans.map(({ event }) => event);
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  // An inward scan is recorded in the country the item was sent to; the newest names the latest.
  const destination = scans.find(scan => scan.country && INWARD.test(scan.wording))?.country;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
