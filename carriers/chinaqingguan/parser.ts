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
import { flowlinkText } from '../jdxexpress/flowlink.js';
import { chinaqingguanStage, statusMap } from './status.js';

export const PROVIDER = 'Rongtong International';
export const CARRIER = 'chinaqingguan';
// A waybill's page is a few kilobytes.
export const CHINAQINGGUAN_MAX_BYTES = 512 * 1024;
// Letters and digits with a digit; the search box asks for twelve characters at least.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{12,30}$/;
const ZONE = 'Asia/Shanghai';
// "2021.06.21 17:56", the firm's clock to the minute; "2021-06-27 10:05:12" as other systems write it.
const CLOCKS = [
  /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})()$/,
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/,
];
// The jump page ThinkPHP shows for a verify code that does not match the picture.
const REFUSED = /您输入的认证码有误/u;
const HEADER = /^您的快递运单号\s*([A-Za-z0-9 -]{1,64}?)\s*的查询结果如下[:：]?$/u;
const MISSING = /^([A-Za-z0-9 -]{1,64}?)\s*单号信息不存在$/u;
// The line that names who delivers the parcel in China and under which number.
const HANDOFF = /转交\s*(.{1,40}?)\s*进行国内派送[，,]?\s*运单号是\s*[:：]\s*([A-Za-z0-9-]{6,40})/u;
// The domestic leg's answer before the courier has any row: "NULL", 查询无结果，请隔段时间再查.
const NO_RESULT = 'NULL';
const SEPARATOR = /^-+$/;
// A place the firm's rows start with, after the kind of goods: "（个人物品）广州白云机场已送仓库".
const PLACE = /^(?:（[^（）]{1,10}）)?(\p{Script=Han}{2,12}?机场)/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;
// Couriers in China a parcel may be handed to, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/极兔/u, 'j-and-t-cn'], [/德邦/u, 'deppon'], [/邮政|EMS/iu, 'china-post'],
];

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeChinaqingguanNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Rongtong International waybills are 12 to 30 letters and digits');
  return number;
}

/** Whether a page is a browser check a CDN or a cloud firewall put in place of the tracker. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** Whether the page is the tracker's refusal of the verify code sent with the number. */
export function chinaqingguanRefusedCode(html: string): boolean {
  const $ = load(html);
  return $('.system-message p.error').length === 1 && REFUSED.test($('.system-message p.error').text());
}

function wallClock(value: string): string {
  const text = clean(value, 40);
  const match = CLOCKS.map((clock) => clock.exec(text)).find(Boolean);
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/** The courier in China the hand-off line names, with its number, when that courier's rules offer the number. */
function handoffOf(text: string): Handoff | null {
  const match = HANDOFF.exec(text);
  if (!match) return null;
  const named = COURIERS.filter(([name]) => name.test(match[1]!)).map(([, carrier]) => carrier);
  const onward = normalizeTrackingNumber(match[2]!);
  if (named.length !== 1 || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

/** The one answer the page gives: the result header or the missing line, with the number it echoes. */
function answerOf($: CheerioAPI, number: string): Element {
  const show = $('#news_show');
  const headers = show.find('li').filter((_, element) => HEADER.test(clean($(element).text(), 200)));
  const missing = show.children('div').filter((_, element) => MISSING.test(clean($(element).text(), 200)));
  if (headers.length + missing.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without its waybill`);
  const [line, pattern] = headers.length ? [headers.first(), HEADER] : [missing.first(), MISSING];
  // The page writes the number in red inside the line.
  const echoed = pattern.exec(clean(line.text(), 200))![1]!;
  if (normalizeTrackingNumber(echoed) !== number || normalizeTrackingNumber(line.find('b').first().text()) !== number) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  if (missing.length) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
  return line.get(0)!;
}

/**
 * The firm's history for one waybill, newest first, from the result page of its search: a header that names the
 * number, then, once the parcel is cleared, the line that hands it on for delivery in China and the rows the
 * domestic leg has, a dashed separator and the firm's own rows, oldest first. Each row is a wall clock on China's
 * clock and a text. `<number>单号信息不存在` for the number asked is the tracker's only answer for a waybill it does
 * not know. A row dated after the lookup keeps its wall clock alone.
 */
export function parseChinaqingguan(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeChinaqingguanNumber(raw);
  if (isChallenge(html)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  const $ = load(html);
  if (!$('#news_show').length) {
    if ($('.system-message').length) throw new SchemaError(PROVIDER, `${PROVIDER} answered its search with an error page`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking page`);
  }
  const header = answerOf($, number);
  const table = $(header).closest('table');
  const rows = table.find('tr').toArray();
  if (!table.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  let handoff: Handoff | null = null;
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  for (const element of rows) {
    const row = $(element);
    const cells = row.children('td');
    if (row.find(header).length || row.children('th').length) continue;
    if (cells.length === 1) {
      // The hand-off line, the only row of one cell after the header.
      const text = clean(cells.text(), 400);
      if (!HANDOFF.test(text)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
      handoff = handoffOf(text);
      continue;
    }
    if (cells.length !== 2) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
    const clock = clean(cells.first().text(), 40);
    if (clock === NO_RESULT || (SEPARATOR.test(clock) && SEPARATOR.test(clean(cells.last().text(), 200)))) continue;
    const local = wallClock(clock);
    // Rows the domestic courier writes can name couriers and phones; the firm's own name none.
    const description = flowlinkText(cells.last().text());
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const location = PLACE.exec(description)?.[1];
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const staged = chinaqingguanStage(description);
    read.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  // The domestic rows come above the firm's own, which are oldest first: the clocks give the order.
  const events = read.map((event, index) => ({ event, index }))
    .sort((a, b) => b.event.local_time!.localeCompare(a.event.local_time!) || b.index - a.index).map(({ event }) => event);
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
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    destination_country: 'CN',
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
