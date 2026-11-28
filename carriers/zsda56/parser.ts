import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, zsda56Stage } from './status.js';

export const PROVIDER = 'Zhuanshunda';
export const CARRIER = 'zsda56';
// The page is about 12 kilobytes with a handful of rows.
export const ZSDA56_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit: ZSD and six digits on the sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The page's answer for a number it holds nothing under: "no such number, add it first".
const NOT_FOUND = '查无此单号';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2019-03-05 12:52:25", or to the minute.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/;
// The firm's warehouse and staff are in Shenzhen.
const CHINA = 'Asia/Shanghai';
const MAX_ROWS = 200;
// A phone: none belongs in a row's text.
const PHONE = /(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)/gu;

/** A parcel number on the firm's tracker, without spaces or hyphens. */
export function normalizeZsda56Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Zhuanshunda numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the page. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A reply that is not the tracking page: a browser check, or a changed page. */
function notTrackingPage(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking page`);
}

/** The number the page's title names: `快件跟踪查询_<number>_…`. */
function titleNumber($: CheerioAPI): string {
  const match = /^快件跟踪查询_([A-Za-z0-9]+)_/u.exec(clean($('title').first().text(), 200));
  return match ? normalizeTrackingNumber(match[1]!) : '';
}

/** The destination the parcel's list item names after 发往, as `TaiWan 台灣`, when it names one country. */
function destinationOf(text: string): string | undefined {
  const english = /^([A-Za-z][A-Za-z .'-]*[A-Za-z])/u.exec(text)?.[1];
  const chinese = /\p{Script=Han}+/u.exec(text)?.[0];
  const code = (english && countryCode(english)) || (chinese && countryCode(chinese)) || undefined;
  return code ?? undefined;
}

function dated(local: string, readAt: number): Partial<CarrierEvent> {
  const instant = firstOccurrence(DateTime.fromISO(local, { zone: CHINA }));
  return instant.toMillis() <= readAt + CLOCK_SKEW_MS
    ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: CHINA, time_zone_basis: 'carrier' } : {};
}

/**
 * Zhuanshunda's history for one parcel, newest first: the page the site's form posts to, with the parcel in a
 * list item that names its number and destination, and a table of rows, newest first, each a clock and a text.
 * The firm works from Shenzhen, so every row is dated on China's clock.
 */
export function parseZsda56(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeZsda56Number(raw);
  const $ = load(body);
  const table = $('table.logistics_floor_6ta');
  if (table.length !== 1 || !$('textarea[name="keyword"]').length) notTrackingPage(body);
  const item = $('li.foreign_number_li').toArray().filter((li) => $(li).attr('id') === `for_${number}`
    && normalizeTrackingNumber(clean($(li).find('p').first().text(), 40)) === number);
  if (!item.length) {
    const notice = clean(table.find('td.logistics_floor_6ta_td').text(), 100);
    if (notice.startsWith(NOT_FOUND) && titleNumber($) === number) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
    }
    if ($('li.foreign_number_li').length) throw new SchemaError(PROVIDER, `${PROVIDER} returned a parcel for another number`);
    notTrackingPage(body);
  }
  const rows = table.find('tr').toArray().filter((row) => $(row).children('td').length > 0);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const events: CarrierEvent[] = rows.map((row) => {
    const cells = $(row).children('td').toArray();
    const clock = cells.length === 2 ? CLOCK.exec(clean($(cells[0]).text(), 40)) : null;
    const local = clock ? `${clock[1]}T${clock[2]}${clock[3] ?? ':00'}` : '';
    const parsed = DateTime.fromISO(local, { zone: 'UTC' });
    if (!clock || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    }
    return { local, description: clean(clean($(cells[1]).text(), 500).replace(PHONE, ''), 300) };
  }).filter((row) => row.description).map((row) => {
    const staged = zsda56Stage(row.description);
    return {
      ...dated(row.local, readAt),
      local_time: row.local,
      description: row.description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const destination = destinationOf(clean($(item[0]).find('p').eq(1).find('span').first().text(), 60));
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
