import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { cambodiaPostStage, statusMap } from './status.js';

export const PROVIDER = 'Cambodia Post';
// A page is about 64 kB with a dozen scans, most of it the site's chrome; a scan adds about 3 kB.
export const CAMBODIA_POST_MAX_BYTES = 2 * 1024 * 1024;
/** The tracking page; its form sends the item code as `search`. */
export const CAMBODIA_POST_SEARCH = 'https://www.cambodiapost.com.kh/tracking/search';

const MAX_ROWS = 300;
// The history's columns, in the site's default Khmer and in English: local date and time,
// country, location, event type, mail category, next office and extra information.
const HEADINGS = [
  ['Local Date and Time', 'Country', 'Location', 'Event Type', 'Mail Category', 'Next Office', 'Extra Information'],
  ['កាលបរិច្ឆេទ និងពេលវេលាក្នុងស្រុក', 'ប្រទេស', 'ទីតាំង', 'ប្រភេទព្រឹត្តិការណ៍', 'ប្រភេទសំបុត្រ', 'ការិយាល័យបន្ទាប់', 'ពត៌មានបន្ថែម'],
].map((names) => JSON.stringify(names));
const COLUMNS = 7;
const ITEM = /^Item No ([A-Z0-9]{1,40})$/;
const NOT_FOUND = 'Not Found';
// "2022-07-21T14:21:11.160Z": the office's wall clock, written with a Z it does not have.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?Z$/;
// The details of the extra information that are kept: why an item was not delivered, what
// happens next, and why it is held. Anything else, the signatory included, is dropped.
const DETAIL = /^-?\s*(?:Reason|Measure|Retention reason)\s*:\s*(.+)$/i;
// An inward scan, in the country the item was sent to.
const INWARD = /\(inb\)$/i;
// Zero-width spaces the Khmer headings carry between words.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;

/**
 * The tracker looks up UPU S10 item codes in IPS: Cambodia Post's own and those of the posts
 * that send mail to Cambodia. The code needs a valid check digit.
 */
export function normalizeCambodiaPostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Cambodia Post tracks S10 item codes');
}

/** The page the tracking form opens for one item. */
export function cambodiaPostItemUrl(number: string): string {
  return `${CAMBODIA_POST_SEARCH}?${new URLSearchParams({ search: number })}`;
}

/** A page without what the tracker's has: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Cambodia Post answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/**
 * A scan's wall clock, calendar-checked. The column is headed "Local Date and Time", and the
 * site writes IPS's local clock with a Z: Phnom Penh's deliveries and attempts read as office
 * hours, and as UTC they would fall late in the evening there. The Z is dropped and the clock
 * stays a wall clock.
 */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Cambodia Post returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

/** The extra information's kept details, one a line; anything else, such as who signed, is dropped. */
function detailsOf($: CheerioAPI, cell: Cheerio<AnyNode>): string[] {
  const copy = cell.clone();
  copy.find('br').replaceWith('\n');
  copy.find('span').each((_, span) => { $(span).append('\n'); });
  return copy.text().split('\n').map((line) => DETAIL.exec(clean(line, 200))?.[1]).filter((detail): detail is string => Boolean(detail))
    .map((detail) => clean(detail, 120));
}

interface Scan { event: CarrierEvent; country: string | null; wording: string }

function scanOf($: CheerioAPI, cells: Cheerio<AnyNode>): Scan {
  const text = (index: number, length: number) => clean(cells.eq(index).text(), length);
  // IPS writes some countries' names in ISO's style, "Netherlands (the)".
  const countryName = text(1, 80).replace(/\s*\(the\)$/i, '');
  const office = text(2, 120);
  const wording = text(3, 200);
  if (!wording) throw new SchemaError(PROVIDER, 'Cambodia Post returned a scan without wording');
  // The office, then its country, which a scan can name alone.
  const location = office.toLowerCase() === countryName.toLowerCase() ? countryName : [office, countryName].filter(Boolean).join(', ');
  const details = detailsOf($, cells.eq(6));
  const description = details.length ? `${wording}: ${details.join('; ')}` : wording;
  const staged = cambodiaPostStage(wording);
  const event: CarrierEvent = {
    local_time: wallClock(text(0, 40)),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, country: countryName ? countryCode(countryName) : null, wording };
}

/**
 * The tracking page for one item: a heading naming it, then its scans, newest first. A code the
 * tracker holds nothing for gets a single "Not Found" row under the same heading, which is not
 * found. The mail category and the next office, a plan rather than a scan, are not read.
 */
export function parseCambodiaPost(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCambodiaPostNumber(rawNumber);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Cambodia Post returned an empty page');
  const $ = load(html);
  const table = $('#tracking > table#dataTable');
  const heading = $('h4').filter((_, node) => clean($(node).text(), 80).startsWith('Item No'));
  if (table.length !== 1 || heading.length !== 1) unexpected(html, 'Cambodia Post returned a page without the item');
  const item = ITEM.exec(clean(heading.text(), 80))?.[1];
  if (!item) throw new SchemaError(PROVIDER, 'Cambodia Post returned an unexpected item heading');
  if (item !== number) throw new IndeterminateError(PROVIDER, 'Cambodia Post answered for another item');
  const headers = table.find('thead th').map((_, cell) => clean($(cell).text().replace(ZERO_WIDTH, ''), 80)).get();
  if (!HEADINGS.includes(JSON.stringify(headers))) throw new SchemaError(PROVIDER, 'Cambodia Post history columns changed');
  const rows = table.children('tbody').children('tr');
  if (!rows.length) throw new SchemaError(PROVIDER, 'Cambodia Post returned an empty history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Cambodia Post returned an oversized history');
  const first = rows.first().children('td');
  if (rows.length === 1 && first.length === 1) {
    if (clean(first.text(), 40) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Cambodia Post returned an unexpected notice');
  }
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== COLUMNS) throw new SchemaError(PROVIDER, 'Cambodia Post returned an invalid history row');
    const scan = scanOf($, cells);
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  const events = scans.map(({ event }) => event);
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  // An inward scan is recorded in the country the item was sent to.
  const destination = scans.find((scan) => scan.country && INWARD.test(scan.wording))?.country;
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
