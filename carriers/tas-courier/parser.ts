import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap, tasStage } from './status.js';

export const PROVIDER = 'tas-courier';
/** TAS Courier's Pegasus Hermes voucher search: the page opens the session its result list reads. */
export const TAS_SEARCH = 'https://tascourier.gr/pegasus/courier04/search00.php';
/** The voucher list the search page loads into itself. */
export const TAS_RESULT = 'https://tascourier.gr/pegasus/courier04/result.php';
// A voucher's list with its history is a few kilobytes; the site's whole page is about forty.
export const TAS_MAX_BYTES = 512 * 1024;

// "V-3975570": a V and the voucher's digits. The search finds a voucher only under its V.
const NUMBER = /^V(\d{6,10})$/;
// The site's page, which the list's address serves instead of the list without the search's session.
const SITE_PAGE = /<html|404 Error Page not Found/i;
// Firewall and bot-check pages that could stand in for the list.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MAX_VOUCHERS = 20;
const MAX_EVENTS = 200;

/** A TAS voucher as `V` and its digits, which the search is asked as `V-` and the digits. */
export function normalizeTasNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 32 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TAS Courier vouchers are a V and six to ten digits');
  return number;
}

/** The voucher as the search writes it: `V-3975570`. */
export function tasQueryNumber(number: string): string {
  return `V-${NUMBER.exec(normalizeTasNumber(number))![1]}`;
}

/** A firewall or bot-check page in place of the list. */
export function isTasBlocked(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A row's `DD/MM/YYYY` day and `HH:MM` time as a wall clock: the reply names no zone. */
function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = TIME.exec(time);
  const iso = date && clock ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!iso || Number(date![3]) < 2000) return invalid('TAS Courier returned an invalid status time');
  return `${iso}T${clock![1]}:${clock![2]}:${clock![3] ?? '00'}`;
}

/** The text of a voucher row's cell by its title. */
function cell($: CheerioAPI, row: ReturnType<CheerioAPI>, title: string): string {
  return clean(row.children('td').filter((_, element) => $(element).attr('title') === title).first().text(), 200);
}

/**
 * The list `result.php?r18p01=<voucher>&having=1` gives TAS Courier's voucher search, the Pegasus
 * Hermes courier software's. Each voucher found has a row, with its voucher, its status, the
 * partner's voucher when another courier delivers, the masked recipient, the person who delivered
 * it, the delivery's day and time and an estimated slot, then a row with its statuses, oldest first,
 * each with its time and day. A voucher the search does not find gets the column headings alone,
 * the answer a voucher written without its V gets too.
 *
 * The row must name the whole voucher asked. The partner's voucher, which does not say which
 * courier it belongs to, the recipient, the person who delivered and the delivery's own columns,
 * which repeat the delivery status, are never read.
 */
export function parseTas(html: string, raw: string): CarrierResult {
  const number = normalizeTasNumber(raw);
  const $ = load(html);
  const list = $('form#voucher_browse_list');
  if (!list.length) {
    if (isTasBlocked(html)) throw new ChallengeError(PROVIDER, 'TAS Courier answered with a browser check');
    if (SITE_PAGE.test(html)) throw new IndeterminateError(PROVIDER, 'TAS Courier did not keep the search session', { reason: 'session_rejected' });
    return invalid('TAS Courier returned an unexpected page');
  }
  const headings = list.find('td.browse_title').map((_, element) => clean($(element).text(), 80)).get();
  if (!headings.includes('Voucher') || !headings.includes('Κατάσταση')) return invalid('TAS Courier voucher list layout changed');
  const rows = list.find('tr').filter((_, element) => $(element).children('td[title="Voucher"]').length > 0);
  if (rows.length > MAX_VOUCHERS) return invalid('TAS Courier returned too many vouchers');
  if (!rows.length) {
    // The search answers an unknown voucher with an empty list; it does not say no voucher exists.
    throw new IndeterminateError(PROVIDER, 'TAS Courier lists no voucher under the number', { reason: 'portal_not_found' });
  }
  const own = rows.filter((_, element) => normalizeTrackingNumber(cell($, $(element), 'Voucher')) === number);
  if (!own.length) throw new IndeterminateError(PROVIDER, 'TAS Courier answered for another voucher');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'TAS Courier lists the voucher more than once', { reason: 'several_parcels' });
  const row = own.first();
  const status = cell($, row, 'Κατάσταση');
  const estimate = cell($, row, 'Εκτιμώμενη ώρα παράδοσης αποστολής');

  // The history row follows the voucher's row, under the voucher's digits.
  const digits = NUMBER.exec(number)![1]!;
  const history = list.find('tr').filter((_, element) => $(element).attr('id') === `vchHistData${digits}`);
  if (history.length > 1) return invalid('TAS Courier returned the voucher\'s history twice');
  const items = history.find('dl dd');
  if (items.length > MAX_EVENTS) return invalid('TAS Courier returned too many statuses');
  const oldestFirst: CarrierEvent[] = items.map((_, element) => {
    const item = $(element);
    const description = clean(item.children('span.statdesc').text(), 200) || invalid('TAS Courier returned a status without its wording');
    const local = wallClock(clean(item.children('span.date').text(), 20), clean(item.children('span.time').text(), 20));
    const staged = tasStage(description);
    return { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  }).get();
  const events = oldestFirst.reverse();
  const facts = unreadEstimates({ estimatedDeliverySlot: estimate });
  const newest = events[0];
  if (!newest) {
    // A voucher without history stands on its status.
    if (!status) return invalid('TAS Courier listed the voucher without a status');
    const summary = tasStage(status);
    return {
      status: summary ? languageStageStatus(summary.stage) : 'unknown',
      ...(summary ? { current_stage: summary.stage, current_stage_source: summary.source } : {}),
      last_status_text: status, last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [],
    };
  }
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...facts,
    events,
  };
}
