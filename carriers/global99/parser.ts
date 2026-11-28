import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { isZtoTrackingNumber } from '../../core/detection/zto.js';
import { ztoFreightWaybill } from '../../core/detection/ztoFreight.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { global99Stage, statusMap } from './status.js';

export const PROVIDER = 'Global Courier International';
export const CARRIER = 'global99';
// The page is about 25 kilobytes with a few dozen rows.
export const GLOBAL99_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit: TK and twelve digits on the firm's own labels.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The page's answer for a number it holds nothing under: an alert, "enter a correct waybill number", and no result table.
const NOT_FOUND = /alert\(\s*['"]请输入正确的运单号/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2025-06-23 17:06:24..": the firm's own rows end their clock in dots, the domestic courier's rows it copies do not.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.*)$/;
const CHINA = 'Asia/Shanghai';
const MAX_ROWS = 200;

// A place the firm writes after its text: "PARIS - FRANCE", "SHANGHAI - CHINA, PEOPLES REPUBLIC", at times with a stray bracket.
const PLACE_SUFFIX = /(?<=^|[\s\p{Script=Han}，,】])([A-Z][A-Z .'&()/-]*?[A-Z.)])\s+-\s+([A-Z][A-Z .,'&()-]*?[A-Z.)])\s*\]?\s*$/u;
// The branches the firm names in English brackets, with the place a map reads and the clock they keep.
const BRANCHES: ReadonlyMap<string, { location: string; zone: string; country: string }> = new Map([
  ['BALI ISLAND', { location: 'Bali, Indonesia', zone: 'Asia/Makassar', country: 'ID' }],
]);
// The end of "CHINA, PEOPLES REPUBLIC" alone after a row's text, which names no place.
const STRAY_COUNTRY = /\s+PEOPLES REPUBLIC$/u;
const ENGLISH_BRACKET = /【([A-Za-z][A-Za-z .'-]{1,40})】/u;
// The row that hands the parcel to a courier in China, with the courier's number: "转国内中通快递，单号：…".
const HANDOFF = /转国内(中通快运|中通快递|中通)[，,]?\s*单号\s*[:：]\s*([A-Z0-9]{8,30})/u;

// A phone: a mobile, a landline with its area code, a courier's hotline.
const PHONE = /(?<![\d-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\d-])/gu;
// Words that introduce a contact: a phone, a hotline, a complaint line, a courier.
const CONTACT = new RegExp(`电话|手机|致电|联系|电联|热线|投诉|呼叫|姓名|司机|业务员|快递员|派件员|揽收员|收派员|${PHONE.source}`, 'u');
// The courtesy a courier's row ends on.
const AFTERWORD = /^(?:如有|如遇|如需|若有|关注|感谢|猜您|可更直接|无需找|获取实时)/u;
// The courier who took the parcel, named with a phone: "由江桥二部张三（138…）".
const PICKED_BY = /由[^，,。；;（(【】]{1,30}[（(]\s*(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})\s*[)）]/gu;
// A name before a mobile in brackets, after a branch, a bracket or a space: "…分部（<landline>）<name>（<mobile>）".
const NAMED = /(?<=^|[\s）)】]|[部点站司厅心])\p{Script=Han}{2,4}[（(]\s*1[3-9]\d{9}\s*[)）]/gu;
const ROLE = /(?:的)?(?:业务员|快递员|派件员|揽收员|收派员)\s*/gu;
const BRACKETED = /【[^【】]*】/gu;
const PARENTHESIZED = /[（(][^（）()]*[)）]/gu;
// Where a domestic courier's row says the parcel is.
const DOMESTIC_PLACES = [
  /^【([^【】]{1,30})】/u,
  /(?:到达|离开|发往|在|中通快运|中通快递)【([^【】]{1,30})】/u,
  /^货物 在 (\S{1,30}) 装车/u,
  /^(\S{1,30}) 正在为您派件$/u,
];

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeGlobal99Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Global Courier International numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the page. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A reply that is not the tracking page: a browser check, or a changed page. */
export function notTrackingPage(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking page`);
}

/**
 * A row's text without the courier, phones, hotlines and the courtesy after them: "【兴安盟】正在派送中"
 * from a row that names the courier with a mobile and goes on to the complaint line.
 */
export function global99Text(raw: string): string {
  const text = clean(raw, 2000).replace(PICKED_BY, '').replace(NAMED, '')
    .replace(BRACKETED, (part) => (CONTACT.test(part) ? '' : part))
    .replace(PARENTHESIZED, (part) => (CONTACT.test(part) ? '' : part))
    .replace(ROLE, '');
  const clauses = text.split(/(?<=[，,。；;！!？?])/u);
  const kept: string[] = [];
  for (const clause of clauses) {
    const words = clause.trim();
    if (!CONTACT.test(words) && !AFTERWORD.test(words)) {
      kept.push(clause);
      continue;
    }
    // A first clause that names a contact keeps its words without the phones.
    if (!kept.length) kept.push(words.replace(PHONE, ''));
    break;
  }
  return clean(kept.join(''), 300).replace(/[，,。；;：:！!\s]+$/u, '');
}

/** A row's wall clock, to the second, checked against the calendar, and whether the firm wrote it. */
function wallClock(value: string): { local: string; own: boolean } {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return { local, own: match[3]!.length > 0 };
}

interface Row {
  readonly local: string;
  readonly own: boolean;
  readonly raw: string;
}

function rowsOf($: CheerioAPI, number: string, body: string): Row[] {
  // The page writes the number it answered for only into its search box.
  const echoed = $('input#expressno').attr('value');
  if (typeof echoed !== 'string') notTrackingPage(body);
  if (normalizeTrackingNumber(echoed) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  const table = $('#queryContext table#queryResult');
  if (!table.length) {
    if (NOT_FOUND.test(body)) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    notTrackingPage(body);
  }
  const rows = table.find('tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return rows.map((row) => {
    const clock = $(row).find('td.row1 .day');
    const context = $(row).find('td.context');
    if (clock.length !== 1 || context.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    return { ...wallClock(clock.text()), raw: context.text() };
  });
}

interface Placed {
  readonly description: string;
  readonly location?: string;
  readonly zone?: string;
  readonly country?: string;
}

/** The place the firm's own row names, moved out of its text, and the clock it keeps when its country keeps one. */
function ownPlace(text: string): Placed {
  const suffix = PLACE_SUFFIX.exec(text);
  if (suffix) {
    const country = clean(suffix[2], 60);
    const location = `${clean(suffix[1], 60)} - ${country}`;
    const description = clean(text.slice(0, suffix.index), 300) || text;
    const name = country.split(',')[0]!.trim();
    const zone = countryTimeZone(name) ?? countryTimeZone(country);
    const code = countryCode(name) ?? countryCode(country);
    return { description, location, ...(zone ? { zone } : {}), ...(code ? { country: code } : {}) };
  }
  const branch = BRANCHES.get(clean(ENGLISH_BRACKET.exec(text)?.[1], 40).toUpperCase());
  if (branch) return { description: text, ...branch };
  return { description: text.replace(STRAY_COUNTRY, '') || text };
}

function domesticPlace(text: string): string {
  for (const pattern of DOMESTIC_PLACES) {
    const found = clean(pattern.exec(text)?.[1], 30);
    if (found) return found;
  }
  return '';
}

/** The courier in China the newest hand-off names, by its catalog id, when the number it gives is that courier's. */
function handoffOf(rows: readonly Row[]): { index: number; partner: Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> } | null {
  for (const [index, row] of rows.entries()) {
    const found = HANDOFF.exec(clean(row.raw, 2000));
    if (!found) continue;
    const number = normalizeTrackingNumber(found[2]!);
    if (found[1] === '中通快运') {
      const waybill = ztoFreightWaybill(number);
      return { index, partner: waybill ? { delivery_carrier: 'zto-freight', delivery_tracking_number: waybill } : {} };
    }
    return { index, partner: isZtoTrackingNumber(number) ? { delivery_carrier: 'zto', delivery_tracking_number: number } : {} };
  }
  return null;
}

function dated(local: string, zone: string | undefined, basis: string, readAt: number): Partial<CarrierEvent> {
  if (!zone) return {};
  const instant = firstOccurrence(DateTime.fromISO(local, { zone }));
  return instant.toMillis() <= readAt + CLOCK_SKEW_MS
    ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: basis } : {};
}

/**
 * Global Courier International's history for one waybill, newest first: the page of
 * `article.php?act=search&tid=56&ydh=<number>`, which echoes the number in its search box and lists
 * the rows under it, newest first. The firm's own rows end their clock in dots and name an
 * overseas branch or a place as "CITY - COUNTRY"; that place's country, when it keeps one clock,
 * dates the row. Once the firm hands the parcel to a courier in China, it copies that courier's rows
 * above its own, on China's clock. Couriers, phones and hotlines are left out.
 */
export function parseGlobal99(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeGlobal99Number(raw);
  const rows = rowsOf(load(body), number, body);
  const handoff = handoffOf(rows);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let destination = handoff ? 'CN' : undefined;
  let origin: string | undefined;
  for (const [index, row] of rows.entries()) {
    const text = global99Text(row.raw);
    if (!text) continue;
    const domestic = !row.own && handoff !== null && index < handoff.index;
    const placed: Placed = domestic ? { description: text, location: domesticPlace(text), zone: CHINA } : ownPlace(text);
    const key = JSON.stringify([row.local, placed.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!domestic && placed.country) {
      origin = placed.country;
      if (placed.country === 'CN') destination = 'CN';
    }
    const staged = global99Stage(placed.description);
    events.push({
      ...dated(row.local, placed.zone, domestic ? 'destination' : 'place', readAt),
      local_time: row.local,
      ...(placed.location ? { location: placed.location } : {}),
      description: placed.description,
      ...(placed.description !== text ? { original_description: text } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
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
    ...(origin && origin !== destination ? { origin_country: origin } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...handoff?.partner,
    events,
  };
}
