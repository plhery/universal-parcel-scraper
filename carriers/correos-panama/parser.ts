import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correosPanamaStage } from './status.js';

export const PROVIDER = 'Correos Panamá';
// The pages are about 11 kB with fourteen scans; each scan adds under a kilobyte.
export const CORREOS_PANAMA_MAX_BYTES = 512 * 1024;
/** The IPS Web Tracking page the tracker's form opens for one item. */
export const CORREOS_PANAMA_ITEM = 'https://operaciones.correospanama.gob.pa/IPSWebTracking/IPSWeb_item_events.aspx';

// Panama keeps UTC-5 all year.
const ZONE = 'America/Panama';
const MAX_ROWS = 500;
// The page's columns. Its extra information spans two cells, the second unread.
const HEADINGS = ['Local Date and Time', 'Country', 'Location', 'Event Type', 'Mail Category', 'Next Office', 'Extra Information'];
const CELLS = HEADINGS.length + 1;
const NO_INFORMATION = 'No information, please check your item identifier';
const ITEM = /^ITEM n° ([A-Z0-9]{1,40})$/;
// "04/22/2026 8:11:10 a. m.": month, day, year and a twelve-hour clock with a
// Spanish marker, the wall clock of the office that scanned the item.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})\s*([ap])\.?\s*m\.?$/i;
// The details of the extra information that are kept: why an item was not
// delivered, what happens next, and why it is held.
const DETAIL = /^(?:Reason|Measure|Retention reason)\s*:\s*(.+)$/i;
// An inward scan, in the country the item was sent to.
const INWARD = /\(inb\)$/i;
// A run of four or more digits, as an office's postcode is written.
const DIGITS = /(?:^|\s)\d{4,}(?=\s|$)/g;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha/i;

/**
 * The tracker looks up UPU S10 item codes: Correos Panamá's own, ending PA,
 * and those of the posts that send mail to Panama. The code needs a valid
 * check digit.
 */
export function normalizeCorreosPanamaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correos Panamá tracks S10 item codes');
}

/** The page for one item, as the tracker's form opens it. */
export function correosPanamaItemUrl(number: string): string {
  return `${CORREOS_PANAMA_ITEM}?${new URLSearchParams({ itemid: number })}`;
}

/** A page without what the tracker's has: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Correos Panamá answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/** A scan's wall clock on the 24-hour clock, calendar-checked. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
  const hour = Number(match?.[4]);
  if (!match || !day || hour < 1 || hour > 12 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new SchemaError(PROVIDER, 'Correos Panamá returned an invalid scan time');
  }
  const hours = (hour % 12) + (match[7]!.toLowerCase() === 'p' ? 12 : 0);
  return `${day}T${String(hours).padStart(2, '0')}:${match[5]}:${match[6]}`;
}

/**
 * When a scan happened. The page heads its clocks "Local Date and Time": an
 * office in Panama keeps Panama's clock, UTC-5 all year. An office abroad's
 * clock stays a wall clock.
 */
function clockOf(wall: string, panama: boolean): { time: string } | { local_time: string } {
  if (panama) {
    const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
    if (zoned.isValid && zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall) return { time: zoned.toISO({ suppressMilliseconds: true }) };
  }
  return { local_time: wall };
}

/** An office without its postcode; a dash or a bare office number is none. */
function officeOf(text: string): string {
  const office = text.replace(DIGITS, ' ').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(office) ? office : '';
}

/** The extra information's kept details, one a line; anything else, such as who signed, is dropped. */
function detailsOf(cell: Cheerio<AnyNode>): string[] {
  const copy = cell.clone();
  copy.find('br').replaceWith('\n');
  return copy.text().split('\n').map((line) => DETAIL.exec(clean(line, 200))?.[1]).filter((detail): detail is string => Boolean(detail))
    .map((detail) => clean(detail, 120));
}

interface Scan { event: CarrierEvent; country: string | null; wording: string }

function scanOf(clock: string, countryName: string, office: string, wording: string, details: readonly string[]): Scan {
  if (!wording) throw new SchemaError(PROVIDER, 'Correos Panamá returned a scan without wording');
  const country = countryName ? countryCode(countryName) : null;
  const place = officeOf(office);
  // The office, then its country, which a scan can name alone.
  const location = place.toLowerCase() === countryName.toLowerCase() ? countryName : [place, countryName].filter(Boolean).join(', ');
  const description = details.length ? `${wording}: ${details.join('; ')}` : wording;
  const staged = correosPanamaStage(wording);
  const event: CarrierEvent = {
    ...clockOf(wallClock(clock), country === 'PA'),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, country, wording };
}

/**
 * The IPS Web Tracking page for one item: a heading naming it, then its scans,
 * oldest first. A code the tracker holds nothing for gets the page's notice
 * instead, which is not found. The next office is a plan, not a scan, and the
 * mail category and the second extra-information cell are not read.
 */
export function parseCorreosPanamaItem(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCorreosPanamaNumber(rawNumber);
  const $ = load(html);
  const headings = $('td > strong').filter((_, node) => clean($(node).text(), 80).startsWith('ITEM n°'));
  if (!headings.length) {
    const notices = $('p > strong').map((_, node) => clean($(node).text(), 120)).get();
    if ($('title').text().trim() === 'IPS Web Tracking/Item Events' && notices.includes(NO_INFORMATION)) throw new NotFoundError(PROVIDER);
    unexpected(html, 'Correos Panamá returned a page without the item');
  }
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Correos Panamá returned several items for one code');
  if (ITEM.exec(clean(headings.text(), 80))?.[1] !== number) throw new SchemaError(PROVIDER, 'Correos Panamá answered for a different item');
  const rows = headings.closest('table').children('tbody').children('tr');
  const headers = rows.eq(1).children('td').map((_, cell) => clean($(cell).text(), 40)).get();
  if (JSON.stringify(headers) !== JSON.stringify(HEADINGS)) throw new SchemaError(PROVIDER, 'Correos Panamá history columns changed');
  if (rows.length - 2 > MAX_ROWS) throw new SchemaError(PROVIDER, 'Correos Panamá returned an oversized history');
  const scans = rows.slice(2).toArray().map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== CELLS) throw new SchemaError(PROVIDER, 'Correos Panamá returned an invalid history row');
    const text = (index: number, length: number) => clean(cells.eq(index).text(), length);
    // IPS writes some countries' names in ISO's style, "Netherlands (the)".
    return scanOf(text(0, 40), text(1, 80).replace(/\s*\(the\)$/i, ''), text(2, 120), text(3, 200), detailsOf(cells.eq(6)));
  });
  const seen = new Set<string>();
  const unique = scans.filter((scan) => {
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).reverse();
  if (!unique.length) throw new NoHistoryError(PROVIDER);
  const events = unique.map(({ event }) => event);
  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time ?? null : null;
  // An inward scan is recorded in the country the item was sent to.
  const destination = unique.find((scan) => scan.country && INWARD.test(scan.wording))?.country;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
