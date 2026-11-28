import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { dyexpressStage, statusMap } from './status.js';

export const PROVIDER = 'Dayi Express';
export const CARRIER = 'dyexpress';
// The page is about 35 kilobytes with a handful of rows.
export const DYEXPRESS_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit: ten digits on the sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The page's answer for a number it holds nothing under: "no express information found, check the number".
const NOT_FOUND = '未找到任何快递信息';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2021-11-29 03:22:18", to the second.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const MAX_ROWS = 200;
// The places a row or the waybill names, as "博宇-台北" or "深圳出口", with their country and the one clock it keeps.
const PLACES: readonly (readonly [RegExp, string, string])[] = [
  [/台北|臺北|新北|桃園|桃园|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉義|嘉义|彰化|宜蘭|宜兰|花蓮|花莲|台東|臺東|台东|屏東|屏东|苗栗|南投|雲林|云林|澎湖|金門|金门|台灣|臺灣|台湾/u, 'TW', 'Asia/Taipei'],
  [/香港/u, 'HK', 'Asia/Hong_Kong'],
  [/澳門|澳门/u, 'MO', 'Asia/Macau'],
  [/新加坡|星加坡/u, 'SG', 'Asia/Singapore'],
  [/印度|孟買|孟买|新德里|德里/u, 'IN', 'Asia/Kolkata'],
  [/深圳|广州|廣州|东莞|東莞|上海|北京|厦门|廈門|义乌|義烏|福州|宝安|寶安|中国|中國|大陆|大陸/u, 'CN', 'Asia/Shanghai'],
];
// A phone, or a clause that names who signed: neither belongs in a row's text.
const PHONE = /(?<!\d)(?:09\d{2}-?\d{3}-?\d{3}|1[3-9]\d{9}|0\d{1,3}-?\d{6,8})(?!\d)/gu;
const SIGNER = /[，,；;]?\s*(?:簽收人|签收人|收件人|收貨人|收货人)\s*[:：]?[^，,；;。！!]*/gu;

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeDyexpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dayi Express numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the page. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A reply that is not the query page: a browser check, or a changed page. */
function notQueryPage(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its query page`);
}

/** A line of a row's text without phones or who signed. */
export function dyexpressText(raw: string): string {
  return clean(clean(raw, 500).replace(SIGNER, '').replace(PHONE, ''), 300).replace(/[，,；;：:\s]+$/u, '');
}

/**
 * The country and clock of a place the page names, when it names one of the places the firm serves. A row's
 * place names the station after a hyphen, as 博宇-台北, the Taiwan partner's Taipei station.
 */
export function placeOf(place: string): { country: string; zone: string } | undefined {
  const station = place.slice(place.lastIndexOf('-') + 1);
  const found = PLACES.find(([pattern]) => pattern.test(station));
  return found ? { country: found[1], zone: found[2] } : undefined;
}

/** A cell of the basic-information table, by the label before it. */
function infoCell($: CheerioAPI, table: Element | undefined, label: string): string {
  if (!table) return '';
  const cells = $(table).find('td').toArray();
  const index = cells.findIndex((cell) => clean($(cell).text(), 40).replace(/[:：]$/u, '') === label);
  return index >= 0 && cells[index + 1] ? clean($(cells[index + 1]).text(), 60) : '';
}

/** The table whose heading row reads `编号<number> <title>:`. */
function tableNamed($: CheerioAPI, scope: Element, number: string, title: string): Element | undefined {
  return $(scope).find('table').toArray().find((table) => {
    const heading = clean($(table).find('tr').first().text(), 80).replace(/\s+/gu, '');
    return heading === `编号${number}${title}:` || heading === `编号${number}:${title}:`;
  });
}

interface Row { readonly local: string; readonly place: string; readonly description: string }

function rowsOf($: CheerioAPI, table: Element): Row[] {
  const rows = $(table).find('tr').toArray().slice(1)
    .map((row) => $(row).children('td').toArray())
    .filter((cells) => !(cells.length === 4 && clean($(cells[0]).text(), 10) === '序号'));
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return rows.map((cells) => {
    if (cells.length !== 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    const clock = CLOCK.exec(clean($(cells[1]).text(), 40));
    const local = clock ? `${clock[1]}T${clock[2]}` : '';
    const parsed = DateTime.fromISO(local, { zone: 'UTC' });
    if (!clock || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
    }
    return { local, place: clean($(cells[2]).text(), 60), description: dyexpressText($(cells[3]).text()) };
  });
}

function dated(local: string, place: string, readAt: number): Partial<CarrierEvent> {
  const zone = placeOf(place)?.zone;
  if (!zone) return {};
  const instant = firstOccurrence(DateTime.fromISO(local, { zone }));
  return instant.toMillis() <= readAt + CLOCK_SKEW_MS
    ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: 'place' } : {};
}

/** The record for the number: its basic information and its tracking table, or not found. */
function recordOf($: CheerioAPI, body: string, number: string): { info?: Element; tracking: Element } {
  const field = $('textarea#keyword');
  const results = $('td').toArray().find((cell) => clean($(cell).text(), 20).replace(/[:：]$/u, '') === '查询结果');
  if (field.length !== 1 || !results) notQueryPage(body);
  const answer = $(results).closest('table');
  const records = answer.find('h3').toArray().filter((heading) => /^第\d+条查询记录$/u.test(clean($(heading).text(), 40)));
  if (!records.length) {
    // The page echoes the number only in its search box when it holds nothing under it.
    const notice = clean(answer.text(), 200);
    if (notice.includes(NOT_FOUND) && normalizeTrackingNumber(field.text()) === number) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    }
    notQueryPage(body);
  }
  const scopes = records.map((heading) => $(heading).parent().get(0)!);
  const matched = scopes.map((scope) => ({ scope, tracking: tableNamed($, scope, number, '跟踪状态') }))
    .filter((entry) => entry.tracking);
  if (matched.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a record for another number`);
  const { scope, tracking } = matched[0]!;
  return { info: tableNamed($, scope, number, '基本信息'), tracking: tracking! };
}

/**
 * Dayi Express's history for one waybill, newest first: the query page the site's form posts to, with a record
 * for the number, `编号<number>`, of its basic information and its rows, newest first, each with a clock to the
 * second, a place and a text. Clocks have no zone: a row is dated on the clock of the place it names.
 */
export function parseDyexpress(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeDyexpressNumber(raw);
  const $ = load(body);
  const { info, tracking } = recordOf($, body, number);
  const rows = rowsOf($, tracking);
  const events: CarrierEvent[] = rows.filter((row) => row.description).map((row) => {
    const staged = dyexpressStage(row.description);
    return {
      ...dated(row.local, row.place, readAt),
      local_time: row.local,
      ...(row.place ? { location: row.place } : {}),
      description: row.description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const origin = placeOf(infoCell($, info, '始发站'))?.country;
  const destination = placeOf(infoCell($, info, '目的地址'))?.country;
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
    ...(origin ? { origin_country: origin } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
