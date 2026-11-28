import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { lqfastWording } from '../anjiexin56/lqfast.js';
import { statusMap, xsbStage } from './status.js';

export const PROVIDER = 'Xinshengbang Logistics';
export const CARRIER = 'xsb56';
// The public sample's page is some ten kilobytes.
export const XSB_MAX_BYTES = 512 * 1024;
/** The clock of the firm's branches, all in China. */
export const XSB_ZONE = 'Asia/Shanghai';

// Letters and digits with a digit: a waybill number (运单号) or a cargo number (货号), as the page takes either.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/;
// The number the page answers about, above its table: 单号：<span id="…lblNum">20023847</span>.
const ECHO = /<span id="ctl00_contentPlaceHolder1_lblNum">([^<]{0,80})<\/span>/g;
// The table of rows under it, up to the platform's credit below.
const TABLE = /<table class="table table-striped">([\s\S]*?)<\/table>/;
const ROW = /<tr>\s*<td>([^<]{0,40})<\/td>\s*<td>([^<]{0,80})<\/td>\s*<td>([\s\S]{0,2000}?)<\/td>\s*<\/tr>/g;
const HEADER = /<tr>\s*<th>序号<\/th>\s*<th>跟踪时间<\/th>\s*<th>跟踪内容<\/th>\s*<\/tr>/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/;
// A row the page lists among the scans to give a contact, as 中转查询电话: and the number beside it.
const CONTACT_ROW = /电话|手机|联系|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/u;
// "深圳(深圳)已开单入库": the city and the branch a row starts with.
const LEADING_PLACE = /^([\p{Script=Han}A-Za-z]{1,20})[(（]([^()（）]{1,30})[)）]/u;
const MAX_ROWS = 300;
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** A Xinshengbang waybill or cargo number, without spaces or hyphens. */
export function normalizeXsbNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Xinshengbang Logistics numbers are five to thirty letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A row's wording and the place it starts with, without the contacts the platform adds to rows. */
export function xsbWording(content: string): { description: string; location?: string } {
  const { description: kept } = lqfastWording(content);
  const place = LEADING_PLACE.exec(kept);
  if (!place) return { description: kept };
  const city = place[1]!;
  const branch = place[2]!.trim();
  const location = city === branch ? city : `${city} ${branch}`;
  return { description: kept.slice(place[0].length).replace(/^[\s，,；;。:：/]+/u, ''), location };
}

/** A row's wall clock to the second, or null for a cell that holds no clock. */
function wallClock(value: string): string | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const local = `${match[1]}T${match[2]!.length === 5 ? `${match[2]}:00` : match[2]}`;
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = isoTime(local, 'UTC');
  if (!parsed || parsed.iso.slice(0, 19) !== local) return invalid('Xinshengbang Logistics returned an invalid scan time');
  return local;
}

/**
 * Reads the firm's tracking page for one number: the number it answers about, then a table of
 * rows, oldest first, each a serial, a wall clock and the sentence. A number the firm holds no
 * waybill under gets the table's header alone. A row the page lists to give a phone, with no clock,
 * is not a scan and is left out.
 */
export function parseXsb(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeXsbNumber(raw);
  const echoes = [...html.matchAll(ECHO)].map((match) => normalizeTrackingNumber(clean(match[1], 80)));
  if (echoes.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Xinshengbang Logistics answered with a verification page');
    return invalid('Xinshengbang Logistics returned a page without its tracking result');
  }
  if (echoes[0] !== number) throw new IndeterminateError(PROVIDER, 'Xinshengbang Logistics answered about another number');
  const table = TABLE.exec(html.slice(html.indexOf('ctl00_contentPlaceHolder1_lblNum')))?.[1];
  if (table === undefined || !HEADER.test(table)) return invalid('Xinshengbang Logistics returned a page without its tracking table');
  const rows = [...table.matchAll(ROW)];
  if (rows.length > MAX_ROWS) return invalid('Xinshengbang Logistics returned an oversized history');
  // Every <tr> after the header must be a row the pattern reads, or the table has changed.
  if ((table.match(/<tr[\s>]/g) ?? []).length !== rows.length + 1) return invalid('Xinshengbang Logistics returned a changed tracking table');
  if (!rows.length) throw new NotFoundError(PROVIDER, 'Xinshengbang Logistics has no waybill under this number');
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, [, , clock, content]] of rows.entries()) {
    const cell = textFromHtml(clock, 80);
    const sentence = textFromHtml(content, 2000);
    const local = wallClock(cell);
    if (!local) {
      if (CONTACT_ROW.test(`${cell} ${sentence}`)) continue;
      return invalid('Xinshengbang Logistics returned a row without a readable time');
    }
    const { description, location } = xsbWording(sentence);
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isoTime(local, XSB_ZONE);
    const staged = xsbStage(description);
    scans.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: XSB_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // A table of contact rows alone holds no scan of the waybill.
  if (!scans.length) return invalid('Xinshengbang Logistics returned a table without a scan');
  const events = scans.sort((a, b) => (a.local < b.local ? 1 : a.local > b.local ? -1 : b.index - a.index)).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
