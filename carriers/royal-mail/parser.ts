import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { isRoyalMailDomesticReference } from '../../core/detection/royalMail.js';
import { royalMailEventStage, royalMailStage, royalMailSummaryStage, statusForStage } from './status.js';

/** Read the response produced by Royal Mail's form and hCaptcha callback. */
const TRACKING_BASE = 'https://www.royalmail.com/track-your-item';
const SUMMARY_API_PREFIX = 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/';
const EVENTS_API_PREFIX = 'https://api-web.royalmail.com/mailpieces/v3/';
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
export function normalizeRoyalMailNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}GB$/.test(value) && !isRoyalMailDomesticReference(value)) {
    throw new InvalidInputError('Royal Mail', 'Royal Mail tracking numbers must match the UPU S10 format or a domestic 2D reference');
  }
  return value;
}

export function royalMailTrackingUrl(trackingNumber: string): string {
  return `${TRACKING_BASE}#/tracking-results/${normalizeRoyalMailNumber(trackingNumber)}`;
}

export function royalMailSummaryApiUrl(trackingNumber: string): string {
  return `${SUMMARY_API_PREFIX}${normalizeRoyalMailNumber(trackingNumber)}`;
}

export function royalMailEventsApiUrl(trackingNumber: string): string {
  return `${EVENTS_API_PREFIX}${normalizeRoyalMailNumber(trackingNumber)}/events`;
}

/** Preserve offset-free wall time instead of assigning a zone to overseas scans. */
function eventTime(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  // A date or wall clock must never acquire the carrier's default timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))$/i.test(raw)) return null;
  return explicitOffsetTime(raw)?.iso ?? null;
}

// Royal Mail appends a Post Office branch's postcode in brackets, and an
// overseas partner can report a delivery office by postcode alone.
const POSTCODE = /^(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{3,10}(?:-\d{3,4})?)$/i;

/** A scan's place without postcodes, which can narrow down a recipient's area. */
function placeName(value: unknown): string {
  const text = cleanScalar(value, 250).replace(/\s*\[([^\]]*)\]$/, (bracket, inner: string) => POSTCODE.test(inner.trim()) ? '' : bracket);
  return POSTCODE.test(text) ? '' : text;
}

/** A delivery estimate reduced to its calendar day. */
function expectedDelivery(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  const day = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0];
  return day && DateTime.fromISO(day).isValid ? day : null;
}

/** Only the field vocabulary consumed by the public tracking application. */
export function parseRoyalMailTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeRoyalMailNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('Royal Mail', 'Royal Mail returned an invalid tracking response');
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  if (errors.some(error => error.errorCode === 'E0015' || error.code === 'E0015')) {
    throw new ChallengeError('Royal Mail', 'Royal Mail denied the tracking session');
  }
  if (String(payload.httpCode) === '429') throw new RateLimitedError('Royal Mail');
  if (errors.length) throw new IndeterminateError('Royal Mail', 'Royal Mail could not confirm the tracking status');
  const mailpiece = payload.mailPieces;
  // Both summary and events endpoints return one object, not the array used by the
  // recent-items endpoint. Never treat a gateway 404 or schema drift as not-found.
  if (!isRecord(mailpiece) || !isRecord(mailpiece.summary)) {
    throw new SchemaError('Royal Mail', 'Royal Mail returned an invalid tracking response');
  }
  if (cleanScalar(mailpiece.mailPieceId).toUpperCase() !== number) {
    throw new SchemaError('Royal Mail', 'Royal Mail did not return the requested parcel');
  }
  const summary = mailpiece.summary;
  const summaryText = cleanScalar(summary.statusDescription);
  if (mailpiece.events !== undefined && !Array.isArray(mailpiece.events)) {
    throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
  }
  const scans = Array.isArray(mailpiece.events) ? mailpiece.events : [];
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const raw of scans.slice(0, MAX_EVENTS_TO_INSPECT)) {
    if (!isRecord(raw)) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
    // The website returns Markdown emphasis, including "**Delivered by**".
    // Normalize it before classification so delivery prose is still redacted.
    const description = cleanScalar(raw.eventName).replace(/\*\*/g, '').trim();
    if (!description) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
    const code = cleanScalar(raw.eventCode, 64);
    const mapped = royalMailEventStage(code);
    const stage = mapped ?? royalMailStage(description) ?? undefined;
    const time = eventTime(raw.eventDateTime);
    const timeText = cleanScalar(raw.eventDateTime, 64);
    const location = placeName(raw.locationName);
    const event: CarrierEvent = {
      ...(time ? { time } : {}),
      ...(!time && timeText ? { provider_time_text: timeText } : {}),
      ...(location ? { location } : {}),
      description: stage === 'delivered' ? 'Delivered' : description,
      ...(stage ? { stage } : {}),
      ...(mapped ? { stage_source: 'carrier_map' } : {}),
      ...(/^[A-Za-z0-9_-]+$/.test(code) ? { provider_code: code } : {}),
    };
    const identity = JSON.stringify([time ?? timeText, location, event.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Royal Mail also sorts the history; upstream order is not guaranteed.
  // A partial comparator can move resolved scans across unresolved overseas
  // clocks. Preserve provider order unless every scan denotes an instant.
  if (events.every(event => event.time)) {
    events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  }
  const trimmed = events.slice(0, MAX_EVENTS_TO_RETURN);
  const summaryCategory = cleanScalar(summary.statusCategory);
  const statusText = summaryText || summaryCategory || trimmed[0]?.description;
  if (!statusText) throw new SchemaError('Royal Mail', 'Royal Mail returned no usable tracking status');
  const stage = royalMailSummaryStage(summaryCategory, statusText) ?? undefined;
  const delivered = stage === 'delivered';
  const deliveredAt = !delivered ? null : trimmed.find(event => event.stage === 'delivered' && event.time)?.time
    ?? (royalMailEventStage(cleanScalar(summary.lastEventCode, 64)) === 'delivered' ? eventTime(summary.lastEventDateTime) : null);
  // Only the full-history reply names the destination.
  const destination = cleanScalar(summary.destinationCountryCode, 8);
  return {
    status: stage ? statusForStage(stage) : 'unknown',
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: delivered ? 'Delivered' : statusText,
    last_update: eventTime(summary.lastEventDateTime) || trimmed[0]?.time || null,
    expected_delivery: delivered || !isRecord(mailpiece.estimatedDelivery)
      ? null : expectedDelivery(mailpiece.estimatedDelivery.date),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    events: trimmed,
    ...(trimmed.length ? {} : { summary_only: true }),
  };
}

/**
 * The page the browser rendered, read only to tell a bot challenge from an
 * inconclusive load. Rendered text never decides not-found: only the
 * structured reply does.
 */
export function parseRoyalMailTrackingHtml(page: string): 'challenged' | 'inconclusive' {
  const $ = load(page);
  $('script, style, noscript').remove();
  const visible = clean($('body').text(), 20_000);
  if (/access denied|just a moment|attention required|are you a robot|verify you are human|before you proceed|unusual traffic/i.test(visible)) {
    return 'challenged';
  }
  return 'inconclusive';
}
