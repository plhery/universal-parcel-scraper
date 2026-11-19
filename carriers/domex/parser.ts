import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { domexStage } from './status.js';

export const PROVIDER = 'Domex';
// Bound both the result JSON and the older server-rendered reply.
export const DOMEX_MAX_BYTES = 512 * 1024;
// Waybills are digits, sometimes after a letter prefix. The tracker checks
// nothing itself, so this takes a margin around the shapes seen.
const NUMBER = /^[A-Z]{0,3}\d{6,12}$/;
const ZONE = 'Asia/Colombo';
// A scan's clock, as "2026-03-04 @ (2:05 pm)".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) @ \((\d{1,2}):(\d{2}) ([ap]m)\)$/i;
// The page's answer for a waybill it has no record of.
const MISSING = /Record Not Found!\s*Sorry, the requested Waybill number is NOT found\./;
// A status line names who recorded it after its last " By ": a branch or hub.
const ACTOR = /^(.+)\s+By\s+(\S.*)$/;
// Actors that are no place: the sender's premises, where a parcel waits to be
// picked up, and a head office department.
const NOT_A_PLACE = /^(?:Customer location|HO\b.*)$/i;
// Sri Lankan phone numbers, as 0700000000, 070-000 0000 or +94 70 000 0000.
const PHONE = /(?<![\dA-Z])(?:\+94|0094|0)(?:[\s-]?\d){9}(?!\d)/gi;
// Bot checks and block pages a CDN or firewall could put in place of the page.
// Every page loads Google's reCAPTCHA script for a form elsewhere on the site,
// so only a rendered widget counts.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Domex waybill number in upper case, as the page shows it; anything else is not one Domex issues. */
export function normalizeDomexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Domex waybill numbers are six to twelve digits, after up to three letters');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/**
 * A scan's clock, to the minute. Domex delivers only in Sri Lanka, whose one
 * zone keeps no daylight saving, and the clocks follow its working day, so
 * they are read as Colombo time.
 */
function scanTime(text: string): { time: string; at: number } {
  const parts = CLOCK.exec(text);
  const hour = parts ? Number(parts[4]) : 0;
  if (!parts || hour < 1 || hour > 12) invalid('Domex returned an invalid scan time');
  const hours = (hour % 12) + (parts[6]!.toLowerCase() === 'pm' ? 12 : 0);
  const wall = `${parts[1]}-${parts[2]}-${parts[3]}T${String(hours).padStart(2, '0')}:${parts[5]}:00`;
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  // A date Luxon would roll over does not read back unchanged.
  if (!zoned.isValid || zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) invalid('Domex returned an invalid scan time');
  return { time: zoned.toISO({ suppressMilliseconds: true }), at: zoned.toMillis() };
}

/**
 * A status line's wording and place. "Parcel Received By Northbay" is the
 * wording "Parcel Received" at Northbay; a line whose actor is no place keeps
 * its whole wording.
 */
export function domexLine(text: string): { description: string; location?: string } {
  const line = clean(text.replace(PHONE, ''), 300);
  const parts = ACTOR.exec(line);
  if (!parts || NOT_A_PLACE.test(parts[2]!)) return { description: line };
  return { description: parts[1]!, location: parts[2]! };
}

interface Row { event: CarrierEvent; at: number; order: number }

/** Read just the status and clock. Waybill details and free-text remarks can contain recipient data. */
function historyRow(text: string, time: string, at: number, order: number): Row {
  const { description, location } = domexLine(text);
  if (!description) invalid('Domex returned a scan without its status');
  const staged = domexStage(description);
  return { at, order, event: {
    time, description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

function requireWhole(id: unknown, number: string): void {
  if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) {
    invalid('Domex returned a record without its waybill');
  }
  if (String(id).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Domex answered for another number');
}

const JSON_CLOCK = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

/** Preserve source precision and any stated offset. Domestic unzoned clocks belong to Colombo. */
function jsonClock(value: unknown): { time: string; at: number } {
  if (typeof value !== 'string') invalid('Domex returned an invalid scan time');
  const parts = JSON_CLOCK.exec(value);
  if (!parts) invalid('Domex returned an invalid scan time');
  const clock = firstOccurrence(DateTime.fromISO(value, { zone: ZONE, setZone: true }));
  if (!clock.isValid || clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value.slice(0, 19)) invalid('Domex returned an invalid scan time');
  return { time: parts[1] ? value : value + clock.toFormat('ZZ'), at: clock.toMillis() };
}

/** The JSON used by the result page. Each scan and the shipment details carry their own trackingNo. */
function jsonHistory(text: string, number: string): CarrierResult {
  let data: unknown;
  try { data = JSON.parse(text); } catch { invalid('Domex returned malformed tracking JSON'); }
  if (!isRecord(data) || typeof data.success !== 'boolean') invalid('Domex returned an invalid tracking envelope');
  // The same generic failure can mean the source could not retrieve the shipment.
  if (!data.success) throw new IndeterminateError(PROVIDER, 'Domex could not retrieve the waybill details');
  if (!isRecord(data.details) || !Array.isArray(data.history)) invalid('Domex returned an incomplete tracking reply');
  requireWhole(data.details.trackingNo, number);
  if (data.history.length > MAX_ROWS) invalid('Domex returned an oversized history');
  const rows = data.history.map((row: unknown, order: number) => {
    if (!isRecord(row)) invalid('Domex returned an invalid scan');
    requireWhole(row.trackingNo, number);
    if (typeof row.status !== 'string') invalid('Domex returned a scan without its status');
    const { time, at } = jsonClock(row.statusDate);
    return historyRow(row.status, time, at, order);
  });
  return resultFromRows(rows);
}

export function parseDomex(body: string, raw: string): CarrierResult {
  const number = normalizeDomexNumber(raw);
  if (body.trimStart().startsWith('{')) return jsonHistory(body, number);
  // Keep reading fully rendered waybills and their identity-bound missing notice.
  const $ = load(body);
  const shown = $('#WayBillNumber');
  if (!shown.length) {
    if (MISSING.test(clean($('body').text(), 200_000))) {
      // The search box keeps the number the page was asked for.
      if (clean($('input#wbno').attr('value'), 80).toUpperCase() !== number) {
        throw new IndeterminateError(PROVIDER, 'Domex answered for another number');
      }
      throw new NotFoundError(PROVIDER);
    }
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Domex answered with a block page');
    invalid('Domex returned a page without its waybill');
  }
  if (shown.length !== 1) invalid('Domex returned more than one waybill');
  const waybill = clean(shown.text(), 80).toUpperCase();
  if (!waybill) invalid('Domex returned a waybill without its number');
  if (waybill !== number) throw new IndeterminateError(PROVIDER, 'Domex answered for another number');

  const tables = $('tbody#tracking-table-body');
  if (tables.length !== 1) invalid('Domex returned a waybill without its tracking table');
  const lines = tables.children('tr').toArray();
  if (lines.length > MAX_ROWS) invalid('Domex returned an oversized history');
  const rows = lines.map((line, order): Row => {
    const cells = $(line).children('td');
    if (cells.length !== 2) invalid('Domex returned a scan without its clock or status');
    const { time, at } = scanTime(clean(cells.eq(0).text(), 40));
    return historyRow(cells.eq(1).text(), time, at, order);
  });
  return resultFromRows(rows);
}

function resultFromRows(rows: Row[]): CarrierResult {
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Newest first, reversing the source order for equal clocks.
  const seen = new Set<string>();
  const events = rows.sort((a, b) => b.at - a.at || b.order - a.order).filter(({ event }) => {
    const identity = JSON.stringify([event.time, event.description, event.location ?? '']);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
