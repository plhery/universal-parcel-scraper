import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { quickFortRow } from './row.js';
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

/**
 * The order's rows as date and sentence: the page's timeline, or the table of its earlier design. A result
 * holding neither is an order without rows only when it is empty.
 */
function orderRows($: CheerioAPI): [string, string][] {
  const result = $('#result');
  const timeline = result.find('.timeline');
  if (timeline.length) {
    const items = timeline.children('.timeline-item').toArray();
    if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quick Fort returned too many scans');
    if (!items.length) throw new NoHistoryError(PROVIDER);
    return items.map((item) => {
      const date = $(item).children('.time');
      const sentence = $(item).children('.context');
      if (date.length !== 1 || sentence.length !== 1) throw new SchemaError(PROVIDER, 'Quick Fort returned an invalid scan');
      return [date.text(), sentence.text()];
    });
  }
  const table = result.find('table');
  if (!table.length) {
    if (clean(result.text(), 200)) throw new SchemaError(PROVIDER, 'Quick Fort returned an order page it does not lay out as before');
    throw new NoHistoryError(PROVIDER);
  }
  const header = table.find('thead th').map((_, node) => clean($(node).text(), 20)).get();
  if (header.join('|') !== '日期|快件状态') throw new SchemaError(PROVIDER, 'Quick Fort tracking columns changed');
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quick Fort returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  return rows.map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'Quick Fort returned an invalid scan');
    return [cells.eq(0).text(), cells.eq(1).text()];
  });
}

/**
 * The tracker's page for one order: its rows, newest first, each with a date and a sentence. The
 * page names the number in its search field, and a number it does not hold gets the site's
 * notice that no order was found. A delivery dated after `readAt` is the day the plan expects.
 */
export function parseQuickFort(html: string, raw: string, readAt = Date.now()): CarrierResult {
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
  const events: (CarrierEvent & { time: string })[] = [];
  const seen = new Set<string>();
  for (const [date, sentence] of orderRows($)) {
    const written = clean(sentence, 400);
    const time = zonedTime(date.trim(), 'yyyy-MM-dd HH:mm:ss', ZONE)?.iso;
    if (!written || !time) throw new SchemaError(PROVIDER, 'Quick Fort returned an invalid scan');
    const { description, location } = quickFortRow(written);
    const key = JSON.stringify([time, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = quickFortStage(description);
    events.push({ time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  events.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  // The timeline is planned: a delivery dated after the lookup is the expected day, on the tracker's clock, and the
  // adapter's planned scans hold the row back until it is due.
  const planned = events.find(event => event.stage === 'delivered' && Date.parse(event.time) > readAt + CLOCK_SKEW_MS);
  const newest = events[0]!;
  const staged = quickFortStage(newest.description!);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: newest.time, expected_delivery: planned ? planned.time.slice(0, 10) : null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
