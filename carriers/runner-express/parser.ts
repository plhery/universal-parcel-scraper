import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { runnerExpressStage, statusMap } from './status.js';

export const PROVIDER = 'Runner Express';
export const CARRIER = 'runner-express';
// A page with forty scans is under 25 kB.
export const RUNNER_EXPRESS_MAX_BYTES = 1024 * 1024;

// Waybills seen are four letters and thirteen digits; the tracker takes other references too.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// "2026-02-24 01:53:00 UTC+08:00 Flight depart": a clock to the second, the offset the scan states, and its wording.
const SCAN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: UTC([+-])(\d{1,2}):(\d{2}))? (\S.*)$/;
// A clock with something other than the page's UTC offset after it.
const ZONED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:UTC|GMT)/i;
// The tracker's answer for a number it holds nothing for, which is also its answer without a number.
const NOT_FOUND = /^This logistics item was not found\.?$/i;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|incapsula|imunify360/i;
const MAX_SCANS = 500;

/** A number for Runner Express's tracker: letters and digits, in capitals, with at least one digit. */
export function normalizeRunnerExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Runner Express looks parcels up by 6 to 40 letters and digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isRunnerExpressBlocked(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The summary table's fields, by their label without its colon: "Way Bill No", "Status Time", "Describe", "TimeZone". */
function summary($: CheerioAPI, table: Cheerio<AnyNode>): Map<string, string> {
  const fields = new Map<string, string>();
  table.find('td').each((_, cell) => {
    const spans = $(cell).children('span');
    if (spans.length !== 2) return;
    const label = clean(spans.first().text(), 60).replace(/\s*[：:]$/, '');
    if (label && !fields.has(label)) fields.set(label, clean(spans.last().text(), 200));
  });
  return fields;
}

/** An offset the page states, "+8:00" or "+08:00", as an ISO offset within the ones clocks use. */
function offsetOf(sign: string, hours: string, minutes: string): string | null {
  const signed = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  if (Number(minutes) > 59 || signed > 14 * 60 || signed < -12 * 60) return null;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}

interface Scan {
  event: CarrierEvent;
  instant?: ParsedTime;
}

/**
 * One line of the history: its clock, the offset it states, and the wording. A
 * clock without an offset stays a wall clock.
 */
function scan(line: string): Scan {
  const parts = SCAN.exec(line);
  if (!parts || (!parts[7] && ZONED.test(line))) return invalid('Runner Express returned an invalid scan');
  const [, year, month, date, hour, minute, second, sign, hours, minutes, wording] = parts as unknown as string[];
  const day = calendarDay(Number(year), Number(month), Number(date));
  if (!day || Number(year) < 2000 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return invalid('Runner Express returned an invalid scan time');
  }
  const wall = `${day}T${hour}:${minute}:${second}`;
  const offset = sign ? offsetOf(sign, hours!, minutes!) : null;
  if (sign && !offset) return invalid('Runner Express returned an invalid scan offset');
  const instant = offset ? explicitOffsetTime(`${wall}${offset}`) ?? invalid('Runner Express returned an invalid scan time') : undefined;
  const description = clean(wording, 500);
  const staged = runnerExpressStage(description);
  return {
    event: {
      ...(instant ? { time: instant.iso } : { local_time: wall }),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    ...(instant ? { instant } : {}),
  };
}

/** Newest first, as the page lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(scans: Scan[]): CarrierEvent[] {
  const [first, last] = [scans[0], scans.at(-1)];
  const older = first && last && first !== last && (first.instant && last.instant
    ? first.instant.timestamp < last.instant.timestamp
    : !first.instant && !last.instant && first.event.local_time! < last.event.local_time!);
  const events = scans.map(({ event }) => event);
  return older ? events.reverse() : events;
}

/**
 * The page Runner Express's tracker serves at `/track/?search_query={number}`,
 * the address its tracking form opens. A parcel gets a summary table (its
 * waybill number, the newest scan's clock and wording, and that scan's offset)
 * and "Web Tracking Details", one line per scan, newest first: a clock to the
 * second, the offset the scan states, such as `UTC+8:00` at the origin
 * warehouse or `UTC+02:00` in Israel, and the wording. A number it holds nothing
 * for gets "This logistics item was not found" in place of both.
 *
 * The summary must name the whole number asked. The page names no recipient.
 */
export function parseRunnerExpress(html: string, raw: string): CarrierResult {
  const number = normalizeRunnerExpressNumber(raw);
  const $ = load(html);
  const content = $('.company-desc');
  if (content.length !== 1) {
    if (isRunnerExpressBlocked(html)) throw new ChallengeError(PROVIDER, 'Runner Express answered with a browser check');
    return invalid('Runner Express returned an unexpected page');
  }
  const table = content.children('table');
  const list = content.children('ul');
  if (!table.length && !list.length) {
    const notices = content.children('p').map((_, element) => clean($(element).text(), 200)).get();
    // A stateless GET: the answer is the number's, though the page does not repeat it.
    if (notices.length === 1 && NOT_FOUND.test(notices[0]!)) throw new NotFoundError(PROVIDER);
    return invalid('Runner Express returned an unexpected page');
  }
  if (table.length !== 1 || list.length !== 1) return invalid('Runner Express returned an unexpected page');

  const fields = summary($, table);
  const echoed = normalizeTrackingNumber(fields.get('Way Bill No') ?? '').toUpperCase();
  if (!echoed) return invalid('Runner Express did not name the waybill');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'Runner Express answered for another number');

  const rows = list.children('li');
  if (clean(rows.first().children('h3').text(), 60) !== 'Web Tracking Details') return invalid('Runner Express history layout changed');
  if (rows.length - 1 > MAX_SCANS) return invalid('Runner Express returned too many scans');
  const scans = rows.slice(1).map((_, element) => scan(clean($(element).text(), 600))).get();
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  const events = newestFirst(scans);
  const newest = events[0]!;
  // The newest scan with a stage leads, unless a newer one may have undone a delivery or a return.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time! }),
    expected_delivery: null,
    events,
  };
}
