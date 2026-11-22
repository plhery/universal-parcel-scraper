import { load, type CheerioAPI } from 'cheerio';
import { isTag } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { jamaicaPostStage } from './status.js';

export const PROVIDER = 'Jamaica Post';
export const JAMAICA_POST_ORIGIN = 'https://jamailtracker.jamaicapost.gov.jm';
/** The Ja Mail tracker's form page, which opens a session and carries the form's token. */
export const JAMAICA_POST_FORM = `${JAMAICA_POST_ORIGIN}/track-status.php`;
/** The page the form posts the number to. */
export const JAMAICA_POST_RESULT = `${JAMAICA_POST_ORIGIN}/track-result.php`;
// The pages are about 5 kB with three rows; each row adds about 600 bytes.
export const JAMAICA_POST_MAX_BYTES = 256 * 1024;

// Jamaica keeps UTC-5 all year.
const ZONE = 'America/Jamaica';
const MAX_ROWS = 300;
const TOKEN = /^[0-9a-f]{32,128}$/i;
// A row's cells: its number, who handled it, the time, the next location, the status and the comments, each after a spacer.
const CELLS = 11;
const DAY = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([A-Z][a-z]+ \d{1,2}, \d{4})$/;
const TIME = /^(\d{2}):(\d{2})$/;
const NOT_FOUND = /^The tracking number you ene?tered - ([a-z0-9]{1,50}) was not found!$/i;
const SERVICE = /^Service: (.{1,80})$/;
const WEIGHT = /^(\d{1,4}(?:\.\d{1,3})?) kgs$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;

/**
 * The tracker reads UPU S10 item codes, which need a valid check digit. Its
 * examples show two local layouts, `ZL` and eight digits and `CSN` and
 * digits, which no public item confirms, so the adapter does not take them.
 */
export function normalizeJamaicaPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Jamaica Post tracks S10 item codes');
}

/** Whether a page is a block page instead of the tracker's own. */
export function isJamaicaPostBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** A page without what the tracker's has: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isJamaicaPostBlocked(html)) throw new ChallengeError(PROVIDER, 'Jamaica Post answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/** The token of the tracker's form, which the result page is posted with. */
export function parseJamaicaPostForm(html: string): string {
  const $ = load(html);
  const form = $('form[action="track-result.php"]');
  const token = form.find('input[name="csrf_token"]').attr('value') ?? '';
  if (form.length !== 1 || !form.find('input[name="Consignment"]').length || !TOKEN.test(token)) {
    unexpected(html, 'Jamaica Post changed its tracking form');
  }
  return token;
}

/** The text of a summary field: what follows its bold label in the same block. */
function field($: CheerioAPI, label: string): string {
  const node = $('span.font-weight-bold').filter((_, span) => clean($(span).text(), 40) === `${label}:`).first();
  if (!node.length) throw new SchemaError(PROVIDER, `Jamaica Post result page lacks ${label}`);
  const parts: string[] = [];
  for (let next = node[0]!.nextSibling; next && !(isTag(next) && ['br', 'span'].includes(next.name)); next = next.nextSibling) {
    parts.push($(next).text());
  }
  return clean(parts.join(' '), 120);
}

/** A row's instant, from its day's heading and its time, on Jamaica's clock. */
function instantOf(day: string, time: string): string {
  const match = TIME.exec(time);
  const date = DateTime.fromFormat(day, 'LLLL d, yyyy', { locale: 'en', zone: 'utc' });
  if (!match || !date.isValid || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new SchemaError(PROVIDER, 'Jamaica Post returned an invalid scan time');
  }
  const zoned = firstOccurrence(DateTime.fromISO(`${date.toISODate()}T${match[1]}:${match[2]}:00`, { zone: ZONE }));
  if (!zoned.isValid) throw new SchemaError(PROVIDER, 'Jamaica Post returned an invalid scan time');
  return zoned.toISO({ suppressMilliseconds: true });
}

/**
 * The Ja Mail tracker's result page for one item: a summary, then its rows
 * under a heading for each day, newest first. A row names who handled the
 * item, when, the next location and any status. A code it holds nothing for
 * gets a notice instead, which is not found. Who handled a row is a staff
 * role, not a place, and the comments, the sender and the addressee are not
 * read.
 */
export function parseJamaicaPostResult(html: string, rawNumber: string): CarrierResult {
  const number = normalizeJamaicaPostNumber(rawNumber);
  const $ = load(html);
  const notice = clean($('div.alert-danger').first().text(), 160);
  const missing = NOT_FOUND.exec(notice);
  if (missing) {
    if (missing[1]!.toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Jamaica Post answered for a different item');
    throw new NotFoundError(PROVIDER);
  }
  if ($('title').text().trim() !== 'Track Mail - Ja Mail Tracker') unexpected(html, 'Jamaica Post returned an unexpected page');
  if (field($, 'Tracking No.').toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Jamaica Post answered for a different item');
  const status = field($, 'Status');
  const weight = WEIGHT.exec(field($, 'Weight'));
  const service = SERVICE.exec(clean($('img[alt^="Service:"]').first().attr('alt'), 100))?.[1];

  const rows = $('table tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jamaica Post returned an oversized history');
  let day = '';
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const heading = $(row).children('th');
    if (heading.length) {
      const date = DAY.exec(clean(heading.first().text(), 60));
      if (!date) throw new SchemaError(PROVIDER, 'Jamaica Post returned an invalid day heading');
      day = date[1]!;
      continue;
    }
    const cells = $(row).children('td');
    // The form's own table, on a page without the item, has no row of this shape.
    if (cells.length !== CELLS) throw new SchemaError(PROVIDER, 'Jamaica Post returned an invalid history row');
    if (!day) throw new SchemaError(PROVIDER, 'Jamaica Post returned a row before its day');
    const text = (index: number, length: number) => clean(cells.eq(index).text(), length);
    const next = text(6, 80);
    const said = text(8, 120);
    if (!next && !said) throw new SchemaError(PROVIDER, 'Jamaica Post returned an empty history row');
    const description = said ? (next ? `${said}: ${next}` : said) : `Next Location: ${next}`;
    const stage = jamaicaPostStage(said || 'Next Location');
    events.push({ time: instantOf(day, text(4, 10)), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists rows newest first; rows of one minute keep its order.
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((left, right) => Date.parse(right.event.time!) - Date.parse(left.event.time!) || left.index - right.index)
    .map(({ event }) => event);
  const current = ordered.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const kilograms = weight ? Number(weight[1]) : 0;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: status || ordered[0]!.description!,
    last_update: ordered[0]!.time!,
    expected_delivery: null,
    ...(kilograms > 0 ? { weight_kg: kilograms } : {}),
    ...(service ? { service_name: service } : {}),
    events: ordered,
  };
}
