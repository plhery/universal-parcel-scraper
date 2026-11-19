import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { quickFortStage } from './status.js';

export const PROVIDER = 'Quick Fort';
// The tracker writes every row on its own Hong Kong clock, wherever the scan was.
const ZONE = 'Asia/Hong_Kong';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const NOT_FOUND = '未查询到对应订单';

/** Quick Fort publishes no number format: one token of letters and digits for the tracker's path. */
export function quickFortNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^[A-Z0-9]{6,40}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Quick Fort tracking takes one number of 6 to 40 letters and digits');
}

// A place's parts: a postcode, a two-letter region or country code, or a name of at most three words.
const POSTCODE = /^(?=[A-Z0-9 -]*\d)[A-Z0-9][A-Z0-9 -]{1,9}$/;
const CODE = /^[A-Z]{2}$/;
const NAME = /^\p{L}[\p{L}\p{M}'’-]*(?: [\p{L}\p{M}'’-]+){0,2}$/u;

/** A comma-separated place without its postcode, names first; undefined when it holds no code or postcode, or a part of no place. */
function placeOf(text: string): string | undefined {
  const parts = text.split(',').map(part => part.trim()).filter(Boolean);
  if (!parts.some(part => POSTCODE.test(part) || CODE.test(part))) return undefined;
  if (!parts.every(part => POSTCODE.test(part) || CODE.test(part) || NAME.test(part))) return undefined;
  const names = parts.filter(part => !CODE.test(part) && !POSTCODE.test(part));
  return [...names, ...parts.filter(part => CODE.test(part))].join(', ');
}

/** A row's sentence, and the place written before or after it, which can hold a postcode. */
function splitRow(text: string): { description: string; location?: string } {
  const before = /^((?:[^,.]{1,40},){2,6})\s*(\S.*)$/.exec(text);
  const leading = before ? placeOf(before[1]!) : undefined;
  if (before && leading !== undefined) return { description: before[2]!, ...(leading ? { location: leading } : {}) };
  const after = /^(.*[.!?])\s*([^.!?]*,[^.!?]*?)\.?$/.exec(text);
  const trailing = after ? placeOf(after[2]!) : undefined;
  if (after && trailing !== undefined) return { description: after[1]!, ...(trailing ? { location: trailing } : {}) };
  return { description: text };
}

/**
 * The tracker's page for one order: its rows, newest first, each with a date and a sentence. The
 * page names the number only in its search field, and a number it does not hold gets the site's
 * notice that no order was found.
 */
export function parseQuickFort(html: string, raw: string): CarrierResult {
  const number = quickFortNumber(raw);
  const $ = load(html);
  const notice = $('.system-message');
  if (notice.length) {
    if (clean(notice.find('h1').text(), 200).includes(NOT_FOUND)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Quick Fort answered with a notice instead of the order');
  }
  const asked = $('#orderid').attr('value');
  if (asked === undefined || !$('#result').length) throw new SchemaError(PROVIDER, 'Quick Fort returned no order page');
  if (normalizeTrackingNumber(asked.slice(0, 64)) !== number) throw new IndeterminateError(PROVIDER, 'Quick Fort answered for another number');
  const table = $('#result table');
  if (!table.length) throw new NoHistoryError(PROVIDER);
  const header = table.find('thead th').map((_, node) => clean($(node).text(), 20)).get();
  if (header.join('|') !== '日期|快件状态') throw new SchemaError(PROVIDER, 'Quick Fort tracking columns changed');
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quick Fort returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const events: (CarrierEvent & { time: string })[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = $(row).children('td');
    const written = cells.length === 2 ? clean(cells.eq(1).text(), 400) : '';
    const time = cells.length === 2 ? zonedTime(cells.eq(0).text(), 'yyyy-MM-dd HH:mm:ss', ZONE)?.iso : undefined;
    if (!written || !time) throw new SchemaError(PROVIDER, 'Quick Fort returned an invalid scan');
    const { description, location } = splitRow(written);
    const key = JSON.stringify([time, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = quickFortStage(description);
    events.push({ time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  events.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const newest = events[0]!;
  const staged = quickFortStage(newest.description!);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: newest.time, expected_delivery: null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
