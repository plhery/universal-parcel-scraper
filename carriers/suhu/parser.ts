import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { suhuStage } from './status.js';

export const PROVIDER = 'Suhu Express';
// The home page is about 250 kB of site around the inline settings that hold the nonce.
export const SUHU_PAGE_MAX_BYTES = 1_000_000;
// A long history is a few kilobytes of JSON.
export const SUHU_MAX_BYTES = 256 * 1024;

// Suhu tracks parcels under its own order numbers and its lines' numbers, so
// the adapter takes any letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z\d]{8,40}$/;
// The settings the tracking form's script reads: the WordPress endpoint and the nonce it sends.
const SETTINGS = /\bsuhuLogistics\s*=\s*(\{[^;<]{1,4000}\})\s*;/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile|challenge-platform/i;
// "2026/3/12 9:05:07": a wall clock without a zone.
const CLOCK = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/;
// The answer for a number the tracker does not know: "Error: no matching order found".
const NOT_FOUND = /^错误信息[:：]\s*未查询到相应订单$/;
const MAX_ORDERS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Suhu's tracker: eight to forty letters and digits, at least one a digit. */
export function normalizeSuhuNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Suhu Express tracks eight to forty letters and digits');
  return number;
}

/** The nonce the home page's tracking form sends, read from its inline settings. */
export function parseSuhuNonce(html: string): string {
  const settings = SETTINGS.exec(html);
  let parsed: unknown;
  try {
    parsed = settings ? JSON.parse(settings[1]!) : undefined;
  } catch {
    parsed = undefined;
  }
  const nonce = isRecord(parsed) ? parsed.nonce : undefined;
  if (typeof nonce === 'string' && /^[0-9a-f]{10}$/.test(nonce)) return nonce;
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Suhu Express answered with a block page');
  throw new SchemaError(PROVIDER, 'Suhu Express home page did not carry its tracking nonce');
}

/** A number the reply names, compared as the tracker echoes it. */
function compact(value: unknown): string {
  const text = cleanScalar(value);
  return text.length <= 64 ? normalizeTrackingNumber(text) : '';
}

/** A scan's date and second as one wall time. The reply gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = match ? DateTime.fromObject({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.year < 2015 || parsed.toFormat('yyyy/M/d H:mm:ss') !== text) {
    throw new SchemaError(PROVIDER, 'Suhu Express returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * The line's number and its carrier, when the number is not the one asked and
 * one carrier's high-confidence rule claims it: the reply names no carrier.
 */
function handoff(order: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = compact(order.trackNo) || compact(order.serviceNo);
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const detected = detectCarrierMatch(reference);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'suhu'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: reference } : {};
}

/**
 * The reply of the tracking form's WordPress action: `{"success":true,"data":{"data":[...]}}`
 * with one order per number asked, each with Suhu's order number (`orderNo`), its line's
 * number (`trackNo`, `serviceNo`), the destination's code and the scans, newest first, each a
 * wall clock, a place, a wording and a four-digit code. An unknown number is
 * `{"success":false}` with a message that says no order matched. The order must be the number
 * asked. Its proof-of-delivery links are not kept.
 */
export function parseSuhu(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSuhuNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean' || !isRecord(payload.data)) {
    throw new SchemaError(PROVIDER, 'Suhu Express returned an invalid envelope');
  }
  if (!payload.success) {
    if (NOT_FOUND.test(clean(payload.data.message, 200))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Suhu Express did not complete the lookup');
  }
  const orders: unknown = payload.data.data;
  if (!Array.isArray(orders) || !orders.length || orders.length > MAX_ORDERS) {
    throw new SchemaError(PROVIDER, 'Suhu Express returned an invalid order list');
  }
  const order: unknown = (orders as unknown[]).find((candidate) => isRecord(candidate)
    && [candidate.orderNo, candidate.trackNo, candidate.serviceNo].some((value) => compact(value) === number));
  if (!isRecord(order)) throw new IndeterminateError(PROVIDER, 'Suhu Express answered for another shipment');
  const rows = order.trackResponses;
  if (rows != null && !Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Suhu Express returned invalid scans');
  if (Array.isArray(rows) && rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Suhu Express returned too many scans');

  const scans: { local: string; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Suhu Express returned an invalid scan');
    const local = wallClock(clean(row.Date, 40));
    const description = clean(row.Content, 200);
    if (!description) throw new SchemaError(PROVIDER, 'Suhu Express returned a scan without wording');
    const code = cleanScalar(row.TrackCode);
    const location = clean(row.Position, 120);
    // The same scan can be listed twice.
    const identity = JSON.stringify([local, code, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const staged = suhuStage(/^\d{4}$/.test(code) ? code : null, description);
    scans.push({ local, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(/^\d{4}$/.test(code) ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) {
    if (cleanScalar(order.errorMsg)) throw new IndeterminateError(PROVIDER, 'Suhu Express answered the order with an error');
    throw new NoHistoryError(PROVIDER);
  }
  // Newest first; equal clocks keep the reply's order.
  scans.sort((left, right) => right.local.localeCompare(left.local));
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const country = countryCode(cleanScalar(order.destinationCountry));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: scans[0]!.local,
    ...(country ? { destination_country: country } : {}),
    ...handoff(order, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
