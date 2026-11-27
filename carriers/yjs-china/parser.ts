import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, yjsChinaStage } from './status.js';

export const PROVIDER = 'YJS Express';
export const CARRIER = 'yjs-china';
// The page is ten kilobytes with a few rows.
export const YJS_CHINA_MAX_BYTES = 256 * 1024;
// Letters and digits with a digit: CHNYJS and eight digits on the public sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const ZONE = 'Asia/Shanghai';
// "2021-04-24 19:55:00": the wall clock the page prints.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// ASP.NET's error page, which the site shows in place of the tracking page when it fails inside.
const SERVER_ERROR = /<title>\s*(?:Runtime Error|[^<]{0,80}(?:Server Error|服务器错误))|Server Error in '[^']*' Application/i;
const MAX_ROWS = 200;

// A person a row names by their role, with the name after it: the courier on the round, the collector, the
// signer. A signature by the sender is the trip back and names no one, so it stays.
const PERSON = /[，,]?\s*(?:派件人|派件员|派送员|收件人|收件员|取件人|取件员|揽件人|揽件员|揽收员|快递员|业务员|配送员|投递员|小件员|签收人)(?![\s:：]*(?:是|为)?[\s:：]*(?:寄件人|发件人))\s*(?:是|为)?\s*[:：]?\s*[^\s，,。；;！!（）()【】:：\d]{0,20}/gu;
// The line asking to call the courier or the station, with its number: "如有疑问，请联系：…".
const CALL = /[，,]?\s*如有疑问\s*[，,]?\s*请?\s*(?:联系|致电|电联|拨打)\s*[:：]?\s*(?:(?:电话|手机)\s*[:：]?\s*)?\+?\d(?:[\s-]?\d){6,}/gu;
// A pickup code, which lets whoever holds it take the parcel from the station or locker.
const PICKUP_CODE = /[，,]?\s*(?:取件码|提货码|取货码)\s*(?:是|为)?\s*[:：]?\s*[A-Z0-9-]{1,20}/giu;
// A phone number, with its label: a run of seven or more digits, as phones are written. A number
// after 单号 is a waybill and stays.
const PHONE = /(?:[，,]?\s*(?:联系)?(?:电话|手机)\s*[:：]?\s*)?(?<![A-Z\d])(?<!单号\s*[:：]?\s*)\+?\d(?:[\s-]?\d){6,}(?![A-Z\d])/giu;
// The line asking to call, left without its number.
const BARE_CALL = /[，,]?\s*如有疑问\s*[，,]?\s*请?\s*(?:联系|致电|电联|拨打)\s*[:：]?\s*(?=[，,。；;！!]|$)/gu;

/** A waybill on the firm's tracker, without spaces or hyphens. */
export function normalizeYjsChinaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YJS Express waybills are 6 to 30 letters and digits');
  return number;
}

/**
 * A row's wording without the people it names, their phone numbers, the station's phone number or a
 * pickup code. The places, the station's name among them, stay.
 */
export function yjsChinaText(value: string): string {
  return clean(value.replace(PERSON, '').replace(CALL, '').replace(PICKUP_CODE, '').replace(PHONE, '').replace(BARE_CALL, ''), 300)
    .replace(/\s+(?=[，,。；;！!])/g, '')
    .replace(/([，,。；;！!])[，,。；;！!]+/g, '$1')
    .replace(/^[\s，,。；;:：]+|[\s，,；;:：]+$/g, '');
}

interface Row {
  readonly local: string;
  readonly description: string;
}

/** A row's wall clock, checked against the calendar. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[1]) < 2001 || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  }
  return `${day}T${match[4]}:${match[5]}:${match[6] ?? '00'}`;
}

/**
 * The page's rows for the whole number asked, newest first, as the page lists
 * them. The page echoes the number only as the value of its search field, so
 * that value must be the number asked. Its result table (`table.printTable`)
 * opens with the firm's own row and the 时间 / 地点和跟踪进度 header, then one
 * row per scan: the clock, an empty cell, the wording and another empty cell.
 * The table with no scan row is the page's answer for a number the firm holds
 * nothing under, its only one.
 */
export function yjsChinaRows(html: string, raw: string): Row[] {
  const number = normalizeYjsChinaNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  const $ = load(html);
  const field = $('input[name="WayBillNo"]');
  if (field.length !== 1) {
    if (SERVER_ERROR.test(html.slice(0, 8_000))) throw new TransportError(PROVIDER, `${PROVIDER} site failed with a server error`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without its search field`);
  }
  if (normalizeTrackingNumber(clean(field.attr('value'), 80)) !== number) {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  const table = $('table.printTable');
  const headings = table.find('th').toArray().map((cell) => clean($(cell).text(), 40));
  if (table.length !== 1 || !headings.includes('时间') || !headings.includes('地点和跟踪进度')) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without its result table`);
  }
  const rows = table.find('tr').toArray().filter((row) => $(row).children('th').length === 0 && $(row).children('td.printName').length === 0);
  if (rows.length === 0) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return rows.map((row) => {
    // The two empty cells are not read.
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    return { local: wallClock(clean(cells.eq(0).text(), 40)), description: yjsChinaText(clean(cells.eq(2).text(), 600)) };
  });
}

/**
 * The firm's history for one waybill, newest first. The page prints each row's
 * wall clock without a zone; the firm is in Chifeng and its rows are scans in
 * China, the last of them a domestic courier's round, so each row keeps its
 * wall clock and is dated on China's clock, the carrier's. A clock that would
 * date a row after the lookup leaves it its wall clock alone. The people a row
 * names, phone numbers and pickup codes come out of its wording, and a row left
 * with nothing is dropped.
 */
export function parseYjsChina(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const rows = yjsChinaRows(html, raw);
  const seen = new Set<string>();
  const dated = rows.flatMap((row, index) => {
    const key = JSON.stringify([row.local, row.description]);
    if (!row.description || seen.has(key)) return [];
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(row.local, { zone: ZONE }));
    const staged = yjsChinaStage(row.description);
    const event: CarrierEvent = {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: row.local,
      description: row.description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return [{ index, event }];
  });
  if (!dated.length) throw new SchemaError(PROVIDER, `${PROVIDER} returned rows without a readable scan`);
  // Newest first on the page, rows of one second in the page's order.
  const events = dated.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || left.index - right.index)
    .map((entry) => entry.event);
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
