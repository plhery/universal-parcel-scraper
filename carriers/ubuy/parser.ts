import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, ubuyStage } from './status.js';

export const PROVIDER = 'UBUYLOGI';
export const CARRIER = 'ubuy';
// The page is about 130 kilobytes, most of it the site's theme.
export const UBUY_MAX_BYTES = 1024 * 1024;
// Letters and digits, with a digit: twelve digits on the sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The table's header row, the only row for a number the tracker holds nothing under.
const HEADER = '以下是来自转运中心转运记录';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2025-04-03 18:22:54", to the second.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const GERMANY = 'Europe/Berlin';
const CHINA = 'Asia/Shanghai';
const MAX_ROWS = 300;
// A row that has the parcel in China: its arrival there, or the courier that delivers it.
const IN_CHINA = /(?:到达|抵达)中国|中国机场|顺丰/u;
// A row of the warehouse in Germany.
const IN_GERMANY = /【德国仓】|德国/u;
// The warehouse's first row names the courier's waybill in China: "【德国仓】 国际运单已生成 单号SF…".
const HANDOFF = /国际运单已生成\s*单号\s*([A-Za-z0-9]{8,30})/u;
// The courier's name and mobile, the delivering outlet's street, who signed and any phone: none belongs in a row.
const COURIER = [
  /[，,]?\s*如有疑问请电联快递员\s*【[^】]*】/gu,
  /【[^】]*(?:电话|手机|联系方式)[^】]*】/gu,
  /[（(]\s*(?:派件人|快递员|收派员|配送员|派送员)[^）)]*[）)]/gu,
  /[，,]?\s*(?:派件人|快递员|收派员|配送员|派送员|签收人(?:是)?|联系电话|电话|手机)\s*[:：]\s*[^，,。；;！!】]*/gu,
  /[，,]\s*地址\s*[:：][^】]*(?=】)/gu,
  /(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)/gu,
];

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeUbuyNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'UBUYLOGI numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the page. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A row's text without the courier's name and mobile, an outlet's street, who signed or any phone. */
export function ubuyText(raw: string): string {
  const text = COURIER.reduce((value, pattern) => value.replace(pattern, ''), clean(raw, 500));
  return clean(text, 300).replace(/[，,；;：:\s]+$/u, '').replace(/[，,]\s*(?=[。！!])/gu, '');
}

/** A reply that is not the tracking page: a browser check, or a changed page. */
function notTrackingPage(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking page`);
}

/** The result table under the heading for the number, `运单号<number>的物流信息`. */
function tableOf($: CheerioAPI, body: string, number: string): Element {
  const table = $('table#queryResult2');
  if (table.length !== 1) notTrackingPage(body);
  const heading = $('div').toArray().filter((div) => /^运单号[A-Za-z0-9]*的物流信息$/u.test(clean($(div).text(), 80)));
  if (heading.length !== 1) notTrackingPage(body);
  const named = /^运单号([A-Za-z0-9]*)的物流信息$/u.exec(clean($(heading[0]).text(), 80))![1]!;
  if (normalizeTrackingNumber(named) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} returned the page of another number`);
  return table.get(0)!;
}

interface Row { readonly local: string; readonly said: string; readonly description: string }

function rowsOf($: CheerioAPI, table: Element): Row[] {
  const rows = $(table).find('tr').toArray();
  const header = rows[0] ? $(rows[0]).children('td') : undefined;
  if (!header || header.length !== 1 || clean(header.text(), 40) !== HEADER) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a table without its header row`);
  }
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return rows.slice(1).map((row) => {
    const cells = $(row).children('td').toArray();
    const clock = cells.length === 3 ? CLOCK.exec(clean($(cells[0]).text(), 40)) : null;
    const local = clock ? `${clock[1]}T${clock[2]}` : '';
    const parsed = DateTime.fromISO(local, { zone: 'UTC' });
    if (!clock || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    }
    const said = clean($(cells[2]).text(), 500);
    return { local, said, description: ubuyText(said) };
  });
}

function dated(local: string, zone: string, basis: 'carrier' | 'destination', readAt: number): Partial<CarrierEvent> {
  const instant = firstOccurrence(DateTime.fromISO(local, { zone }));
  return instant.toMillis() <= readAt + CLOCK_SKEW_MS
    ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: basis } : {};
}

/** SF Express and its waybill, from the warehouse's row that names it, when SF Express's own rules take it. */
function partnerOf(rows: readonly Row[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  // The oldest row that names one: the warehouse's first.
  const found = [...rows].reverse().map((row) => HANDOFF.exec(row.said)).find((match) => match);
  const waybill = found ? normalizeTrackingNumber(found[1]!) : '';
  if (!waybill || waybill === number || !(detectCarrierMatch(waybill).candidates as string[]).includes('sf-express')) return {};
  return { delivery_carrier: 'sf-express', delivery_tracking_number: waybill };
}

/**
 * UBUYLOGI's history for one waybill, newest first: the tracking page, with a heading that names the number and a
 * table of rows, newest first, each a clock and a text. The warehouse in Germany writes the first rows; once the
 * parcel reaches China, the rows are the customs broker's and then SF Express's, which the page copies. Clocks have
 * no zone: the rows older than the first one that has the parcel in China are dated on Germany's clock, that row
 * and the newer ones on China's.
 */
export function parseUbuy(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeUbuyNumber(raw);
  const $ = load(body);
  const rows = rowsOf($, tableOf($, body, number));
  if (!rows.length) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
  // Rows run newest first: the oldest row in China and every newer one are China's.
  let arrival = -1;
  rows.forEach((row, index) => {
    if (IN_CHINA.test(row.said) && !row.said.includes('【德国仓】')) arrival = index;
  });
  const events: CarrierEvent[] = rows.flatMap((row, index) => {
    if (!row.description) return [];
    const china = arrival >= 0 && index <= arrival;
    const staged = ubuyStage(row.description);
    return [{
      ...dated(row.local, china ? CHINA : GERMANY, china ? 'destination' : 'carrier', readAt),
      local_time: row.local,
      description: row.description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    }];
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const partner = partnerOf(rows, number);
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
    ...(rows.some((row) => IN_GERMANY.test(row.said)) ? { origin_country: 'DE' } : {}),
    ...(arrival >= 0 || partner.delivery_carrier ? { destination_country: 'CN' } : {}),
    ...partner,
    events,
  };
}
