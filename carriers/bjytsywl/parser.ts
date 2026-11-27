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
import { bjytsywlStage, statusMap } from './status.js';

export const PROVIDER = 'Yuantongshengyuan Logistics';
export const CARRIER = 'bjytsywl';
// The page is seven kilobytes with a few rows.
export const BJYTSYWL_MAX_BYTES = 256 * 1024;
// Letters and digits with a digit: twelve digits on the public sample. The form splits numbers at ";".
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const ZONE = 'Asia/Shanghai';
// The page's answer for a number the firm holds nothing under.
const NOT_FOUND = /^查询的单号不存在[，,]?\s*请重新输入$/u;
// "2020-05-11 17:32": the wall clock the page prints, to the minute.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
// ThinkPHP's notice page, which the site shows when it reads no number from the form.
const NOTICE = /<title>\s*跳转提示\s*<\/title>/;
// PHP's own failure, which the site prints in place of every page when it fails inside.
const SERVER_ERROR = /(?:^|>)\s*(?:Fatal error|Parse error)\s*(?:<\/b>)?\s*:/i;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;

// A person a row names by their role: the collector, a courier or the signer, with the name after it.
// A signature by the sender is the trip back and names no one, so it stays.
const PERSON = /[，,]?\s*(?:收件员|揽收员|揽件员|取件员|派件员|派送员|快递员|业务员|配送员|签收人)(?![\s:：]*(?:是|为)?[\s:：]*(?:寄件人|发件人))\s*(?:是|为)?\s*[:：]?\s*[^\s，,。；;！!（）()【】:：\d]{0,12}/gu;
// A phone number, with its label: a run of seven or more digits, as phones are written. A number
// after 单号 is a waybill and stays.
const PHONE = /(?:[，,]?\s*(?:联系)?(?:电话|手机)\s*[:：]?\s*)?(?<![A-Z\d])(?<!单号\s*[:：]?\s*)\+?\d(?:[\s-]?\d){6,}(?![A-Z\d])/giu;

/** A waybill on the firm's tracker, without spaces or hyphens. */
export function normalizeBjytsywlNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Yuantongshengyuan Logistics waybills are 6 to 30 letters and digits');
  return number;
}

/** A row's wording without the person it names or a phone number. */
export function bjytsywlText(value: string): string {
  return clean(value.replace(PERSON, '').replace(PHONE, ''), 300)
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
 * The page's rows for the whole number asked, oldest first, as the page lists
 * them. The page echoes each number it was asked in a tab (`li#cnum_<n>`) over
 * its rows (`ul#ul_<n>`); a page whose tab is another number's is not an answer
 * for this one. Each row is `<p><span>clock</span><i>wording</i></p>`.
 */
export function bjytsywlRows(html: string, raw: string): Row[] {
  const number = normalizeBjytsywlNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  if (NOTICE.test(html.slice(0, 4_000))) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not read the number asked`);
  const $ = load(html);
  const tabs = $('li.liinfo[id^="cnum_"]');
  if (!tabs.length && SERVER_ERROR.test(html.slice(0, 4_000))) throw new TransportError(PROVIDER, `${PROVIDER} site failed with a server error`);
  if (tabs.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without one tracking result`);
  const tab = tabs.first();
  if (normalizeTrackingNumber(clean(tab.text(), 80)) !== number) {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  const list = $(`ul#ul_${(tab.attr('id') ?? '').slice('cnum_'.length)}`);
  if (list.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a result without its rows`);
  const rows = list.find('li > p');
  if (rows.length === 0) {
    if (NOT_FOUND.test(clean(list.text(), 200))) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a result with neither rows nor its answer`);
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return rows.toArray().map((row) => {
    // The clock is the span's own text; what the span's <b> may hold is not read.
    const span = $(row).children('span').first();
    const clock = clean(span.clone().children().remove().end().text(), 40);
    const wording = $(row).children('i');
    if (span.length !== 1 || wording.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    return { local: wallClock(clock), description: bjytsywlText(clean(wording.text(), 600)) };
  });
}

/**
 * The firm's history for one waybill, newest first. The page prints each row's
 * wall clock without a zone; the firm is in Beijing and its rows are China's
 * sorting centres and couriers, so each row keeps its wall clock and is dated
 * on China's clock, the carrier's. A clock that would date a row after the
 * lookup leaves it its wall clock alone. A person the row names and any phone
 * number come out of its wording, and a row left with nothing is dropped.
 */
export function parseBjytsywl(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const rows = bjytsywlRows(html, raw);
  const seen = new Set<string>();
  const dated = rows.flatMap((row, index) => {
    const key = JSON.stringify([row.local, row.description]);
    if (!row.description || seen.has(key)) return [];
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(row.local, { zone: ZONE }));
    const staged = bjytsywlStage(row.description);
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
  // Oldest first on the page; the result runs newest first, rows of one minute in the reverse of their order.
  const events = dated.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || right.index - left.index)
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
