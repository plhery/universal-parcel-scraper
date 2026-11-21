import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { tpStage } from './status.js';

export const PROVIDER = 'TP Logistics';
export const TP_ORIGIN = 'https://tptrack.info';
/** The search page, which lists the parcel its `id` names with a button to its history. */
export const TP_SEARCH = `${TP_ORIGIN}/ecom/dtrack.php`;
/** The history page the search page's button opens. */
export const TP_HISTORY = `${TP_ORIGIN}/ecom/tdetail.php`;
// Each page is under 10 kB; each scan adds a few hundred bytes.
export const TP_MAX_BYTES = 512 * 1024;

// Every branch is in Thailand, which keeps UTC+7 all year.
const ZONE = 'Asia/Bangkok';
// A document number as the tracker's first box takes it: three letters and twelve digits.
const NUMBER = /^[A-Z]{3}\d{12}$/;
// The history button: `getpage3('{number}','a1')`.
const HISTORY_BUTTON = /^getpage3\('([^']{0,64})','a1'\)$/;
// The script the search page adds for a number it holds nothing for, which loads its "Not found this Code" box.
const NOT_FOUND_SCRIPT = /\$\.get\(\s*'false\.php'/;
// A day and clock as the history page prints them, day first: "07/06/2025 11:17:00".
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// The code archived history pages printed in brackets before a wording: "(6) ดำเนินการ…".
const CODED = /^\((\d{1,2}(?:-\d{1,2})?)\)\s*(.+)$/;
// A goods line: the description, then its quantity.
const GOODS = /^(.*?)\s*Qty:\s*(\d{1,6})$/;
// A delivery photo or signature, filed under the number it belongs to.
const PHOTO = /\/SiteImages\/[^/]+\/[^/]+\/([^/]{1,64})\//;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_Incapsula_Resource|AwsWafIntegration|captcha-delivery/i;
const MAX_ROWS = 300;

/** One line of the search page's answer. */
export interface TpListing {
  item: string;
  quantity: string;
  destination: string;
  status: string;
}

/** A TP Logistics document number: three letters and twelve digits. Anything else is not one the tracker's first box looks up. */
export function normalizeTpNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TP Logistics document numbers are three letters and twelve digits');
  return number;
}

export const tpSearchUrl = (number: string) => `${TP_SEARCH}?id=${encodeURIComponent(number)}&type=a1`;
export const tpHistoryUrl = (number: string) => `${TP_HISTORY}?fn=a1&code=${encodeURIComponent(number)}`;

/** Whether a page is a bot check instead of the carrier's own. */
export function isTpChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isTpChallenge(html)) throw new ChallengeError(PROVIDER, 'TP Logistics answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The header cells of a table's first row. */
function headers($: CheerioAPI, table: Cheerio<Element>): string[] {
  return table.find('tr').first().children('th').toArray().map((cell) => clean($(cell).text(), 40));
}

/** A table's data rows, without its header row. */
function dataRows($: CheerioAPI, table: Cheerio<Element>): Cheerio<Element>[] {
  return table.find('tr').toArray().filter((row) => $(row).children('td').length > 0).map((row) => $(row));
}

/**
 * The search page `dtrack.php?id={number}&type=a1` renders: a table of the
 * goods with their quantity, destination district and summary status, and a
 * button to the history that names the number. A number the tracker holds
 * nothing for gets the page without the table, with a script that loads a
 * "Not found this Code" box. The button must name the number asked.
 */
export function parseTpSearch(html: string, raw: string): TpListing[] {
  const number = normalizeTpNumber(raw);
  const $ = load(html);
  // Both answers keep the box the not-found notice loads into and the box the menus load into.
  if ($('div#false').length !== 1 || $('div#border').length !== 1) unexpected(html, 'TP Logistics returned a page without its tracker');
  const notFound = $('script').toArray().some((script) => NOT_FOUND_SCRIPT.test($(script).text()));
  const tables = $('table').filter((_, table) => headers($, $(table)).join('|') === 'ITEM|QTY.|DESTINATION|STATUS');
  if (notFound) {
    if (tables.length) unexpected(html, 'TP Logistics returned an answer beside its not-found notice');
    throw new NotFoundError(PROVIDER);
  }
  if (tables.length !== 1) unexpected(html, 'TP Logistics returned a page without its answer');
  const named = $('button[onmousedown]').toArray()
    .map((button) => HISTORY_BUTTON.exec(clean($(button).attr('onmousedown'), 100))?.[1])
    .filter((value): value is string => value !== undefined);
  if (!named.length) unexpected(html, 'TP Logistics returned an answer without its history button');
  if (named.some((value) => normalizeTrackingNumber(value) !== number)) {
    throw new IndeterminateError(PROVIDER, 'TP Logistics answered for another parcel');
  }
  const listings = dataRows($, tables.first()).map((row) => {
    const cells = row.children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'TP Logistics returned an incomplete answer');
    const [item, quantity, destination, status] = cells.toArray().map((cell) => clean($(cell).text(), 200)) as [string, string, string, string];
    return { item, quantity, destination, status };
  });
  if (!listings.length) throw new SchemaError(PROVIDER, 'TP Logistics returned an answer without its parcel');
  return listings;
}

/** A day and clock the page prints day first, as the branch's wall clock; text that reads as neither is kept as printed. */
function wallTime(text: string): Pick<CarrierEvent, 'local_time'> | { provider_time_text: string } {
  const parts = CLOCK.exec(text);
  if (parts) {
    // The page prints Common Era years; a Buddhist Era year, 543 ahead, is read the same.
    const printed = Number(parts[3]);
    const day = calendarDay(printed > 2400 ? printed - 543 : printed, Number(parts[2]), Number(parts[1]));
    const [hour, minute, second] = [Number(parts[4]), Number(parts[5]), Number(parts[6] ?? 0)];
    if (day && hour < 24 && minute < 60 && second < 60) {
      const pad = (value: number) => String(value).padStart(2, '0');
      return { local_time: `${day}T${pad(hour)}:${pad(minute)}:${pad(second)}` };
    }
  }
  return { provider_time_text: clean(text, 60) };
}

/** An event with its stage, when the map or the shared rules give one. */
function staged(event: CarrierEvent): CarrierEvent {
  const stage = tpStage(String(event.description));
  return stage ? { ...event, stage: stage.stage, stage_source: stage.source } : event;
}

/** The table under one of the history page's headings, or an empty selection. */
function tableUnder($: CheerioAPI, heading: string): Cheerio<Element> {
  return $('h2').filter((_, element) => clean($(element).text(), 40) === heading).first().nextAll('table').first();
}

/** One row of the movement table: the wording, its day and clock, the province and the branch. The branch is not kept. */
function movement(row: Cheerio<Element>): CarrierEvent {
  const cells = row.children('td');
  if (cells.length !== 4) throw new SchemaError(PROVIDER, 'TP Logistics returned an incomplete scan');
  const detail = clean(cells.eq(0).text(), 200);
  const coded = CODED.exec(detail);
  const description = coded ? coded[2]! : detail;
  if (!description) throw new SchemaError(PROVIDER, 'TP Logistics returned a scan without its wording');
  const province = clean(cells.eq(2).text(), 100);
  return staged({
    ...wallTime(clean(cells.eq(1).text(), 60)),
    ...(province ? { location: province } : {}),
    description,
    ...(coded ? { provider_code: coded[1]! } : {}),
  });
}

/** One row of the hold reasons: the reason as printed, with its number, and its day and clock. */
function holdReason(row: Cheerio<Element>): CarrierEvent {
  const cells = row.children('td');
  if (cells.length !== 2) throw new SchemaError(PROVIDER, 'TP Logistics returned an incomplete hold reason');
  const description = clean(cells.eq(0).text(), 200);
  if (!description) throw new SchemaError(PROVIDER, 'TP Logistics returned a hold reason without its wording');
  return staged({ ...wallTime(clean(cells.eq(1).text(), 60)), description });
}

/**
 * Rows keyed for sorting by their clock. A row without a readable one takes
 * the key of the row above it, so it keeps its place in the page's order.
 */
function keyed(events: CarrierEvent[]): { event: CarrierEvent; key: string }[] {
  let previous = '';
  return events.map((event) => {
    previous = typeof event.local_time === 'string' ? event.local_time : previous;
    return { event, key: previous };
  });
}

/** The value of each "Label : value" line of the sender and recipient box, by its label. */
function partyFields($: CheerioAPI): Map<string, string> {
  const box = $('h2').filter((_, element) => clean($(element).text(), 40) === 'SENDER INFO').first().parent().clone();
  box.find('h2, br').after('\n');
  const fields = new Map<string, string>();
  for (const line of box.text().split('\n')) {
    const parts = /^([^:]{1,40}?)\s*:\s*(.*)$/.exec(clean(line, 300));
    if (parts) fields.set(parts[1]!.toLowerCase(), clean(parts[2], 200));
  }
  return fields;
}

/** The goods lines of the history page, as "description|quantity". */
function goodsLines($: CheerioAPI): string[] {
  const box = $('h2').filter((_, element) => clean($(element).text(), 40) === 'GOODS INFO').first().parent();
  return box.find('h3').toArray().map((element) => {
    const parts = GOODS.exec(clean($(element).text(), 300));
    return parts ? `${parts[1]}|${parts[2]}` : '';
  });
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((line, index) => line === [...b].sort()[index]);

/**
 * The history page `tdetail.php?fn=a1&code={number}` renders, read with the
 * search page's answer for the same number: the sender and recipient, the
 * goods, the movement table, the hold reasons and, once delivered, the
 * signature and photos, which are filed under the number. Scans are listed
 * newest first on the branches' wall clocks. The page is tied to the number
 * by those photos, else by goods that match the search page's; a page that
 * names another number, or that neither ties, is not read.
 */
export function parseTpHistory(html: string, raw: string, listings: readonly TpListing[]): CarrierResult {
  const number = normalizeTpNumber(raw);
  const $ = load(html);
  const moves = tableUnder($, 'MOVEMENT');
  const holds = tableUnder($, 'HOLD REASON');
  if (!moves.length) {
    // The tracker gives a number it holds no history for the page's menu bar alone.
    if ($('a.navbar-brand').length === 1 && !$('h2').length) {
      throw new IndeterminateError(PROVIDER, 'TP Logistics listed the parcel without its history page');
    }
    unexpected(html, 'TP Logistics returned a history page without its movements');
  }
  if (headers($, moves).join('|') !== 'Detail|Time|Province|BranchID' || (holds.length && headers($, holds).join('|') !== 'Detail|Time')) {
    unexpected(html, 'TP Logistics returned a history page with changed tables');
  }

  // A photo's folder, and its alt text when that is an identifier, name the parcel it was taken for.
  const photos = $('img').toArray().flatMap((image) => {
    const folder = PHOTO.exec($(image).attr('src') ?? '')?.[1];
    const alt = clean($(image).attr('alt'), 64);
    return [...(folder ? [folder] : []), ...(/^[A-Za-z0-9]{6,40}$/.test(alt) ? [alt] : [])];
  }).map((value) => normalizeTrackingNumber(value));
  if (photos.some((value) => value !== number)) throw new IndeterminateError(PROVIDER, 'TP Logistics answered for another parcel');
  const goods = goodsLines($);
  const listed = listings.map((listing) => `${listing.item}|${listing.quantity}`);
  const described = goods.some((line) => /^[^|]+\|/.test(line));
  const tied = photos.length > 0 || (described && sameLines(goods, listed));
  if (!tied) throw new IndeterminateError(PROVIDER, 'TP Logistics answered with a history it does not tie to the parcel');

  const moveRows = dataRows($, moves);
  const holdRows = holds.length ? dataRows($, holds) : [];
  if (moveRows.length + holdRows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TP Logistics returned an oversized history');
  // Both tables list the newest row first. A hold reason shares its clock with the hold it explains and goes above it.
  const rows = [...keyed(holdRows.map(holdReason)), ...keyed(moveRows.map(movement))];
  const events = rows.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? 1 : -1)).map(({ event }) => event);

  const status = listings[0]?.status ?? '';
  const summed = status ? tpStage(status) : null;
  const latest = events.find((event) => event.stage);
  // The summary status in the carrier's words leads; else the newest scan with a stage; else the shared rules' reading of the summary.
  const [stage, source] = summed?.source === 'carrier_map' || !latest
    ? [summed?.stage, summed?.source]
    : [latest.stage as Stage, latest.stage_source];
  const newest = events[0];
  if (!newest && !stage) throw new NoHistoryError(PROVIDER, 'TP Logistics lists the parcel without a status or a scan', { reason: 'listed' });

  const fields = partyFields($);
  const sender = fields.get('sender name') ?? '';
  const receiver = fields.get('recipient name') ?? '';
  const address = fields.get('recipient address') ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(source) } : {}),
    last_status_text: status || (newest ? String(newest.description) : null),
    last_update: null,
    ...(typeof newest?.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    timezone: ZONE,
    ...(sender ? { sender_name: sender } : {}),
    ...(receiver ? { receiver_name: receiver } : {}),
    ...(address ? { receiver_address: address } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
