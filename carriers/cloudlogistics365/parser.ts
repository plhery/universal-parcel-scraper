import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { qunhangStage, statusMap } from './status.js';

export const PROVIDER = 'Qunhang International Logistics';
export const CARRIER = 'cloudlogistics365';
// A shipment's fragment is a few kilobytes.
export const QUNHANG_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: the YTO waybill Qunhang ships under, or its own order number.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const ZONE = 'Asia/Shanghai';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// "2026-10-22 12:54" on Qunhang's rows, "2026-11-02 16:41:56" on the rows it copies from YTO.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/;
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 200;

// A phone: a mobile, a landline with its area code, a courier's hotline.
const PHONE = /(?<![\d-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\d-])/gu;
// Words that introduce a contact: the operator's, a courier's, a hotline or a complaint line.
const CONTACT = new RegExp(`电话|手机|致电|联系|电联|热线|投诉|呼叫|姓名|司机|揽收人|快递员|业务员|派件员|${PHONE.source}`, 'u');
// What a row goes on to after its news: a courtesy, or the time of the next update.
const AFTERWORD = /^(?:如有|如遇|如需|若有|关注|感谢|预计|因运输)/u;
// A courier named with a phone: "【…】的张三（138…）正在为您派件".
const NAMED_COURIER = /(?:的|由)[^，,。；;（(【】]{1,30}[（(]\s*(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})\s*[)）]/gu;
// The pickup point's address after its name, on the row that says the parcel waits there.
const POINT_ADDRESS = /(已到达\[代收点\]\([^()]{1,40}\))[^，,。；;]*/u;
const BRACKETED = /【[^【】]*】/gu;
const PARENTHESIZED = /[（(][^（）()]*[)）]/gu;
// The airport or port that cleared the parcel, after the text: "中国天津滨海国际机场/TSN(CN)", kept without the
// country's name in front, which its code in brackets repeats.
const CLEARED_AT = /\s+(?:中国)?(\S{2,60}\([A-Z]{2}\))$/u;
// Where a YTO row says the parcel is.
const STATION = [/^【([^【】]{1,30})】/u, /(?:在|到达|离开)【([^【】]{1,30})】/u];

/** A waybill or order number on Qunhang's tracker, without spaces or hyphens. */
export function normalizeQunhangNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Qunhang numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the fragment. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

function notFragment(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking fragment`);
}

/**
 * A row's text without the operator's contact, couriers, phones, hotlines, the pickup point's address and
 * the courtesy after them: "国际运输环节中" from a row that goes on to name the operator's contact and the
 * customs line, "【…】正在为您派件" from one that names the courier with a mobile.
 */
export function qunhangText(raw: string): string {
  const text = clean(raw, 2000).replace(NAMED_COURIER, '').replace(POINT_ADDRESS, '$1')
    .replace(BRACKETED, (part) => (CONTACT.test(part) ? '' : part))
    .replace(PARENTHESIZED, (part) => (CONTACT.test(part) ? '' : part));
  const kept: string[] = [];
  for (const clause of text.split(/(?<=[，,。；;！!？?])/u)) {
    const words = clause.trim();
    if (!CONTACT.test(words) && !AFTERWORD.test(words)) {
      kept.push(clause);
      continue;
    }
    // A first clause that names a contact keeps its words without the phones.
    if (!kept.length) kept.push(words.replace(PHONE, ''));
    break;
  }
  return clean(kept.join(''), 300).replace(/[，,。；;：:！!、\s]+$/u, '');
}

/** A row's wall clock, to the second, checked against the calendar; a clock to the minute is at :00. */
function wallClock(value: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/** The shipment the number names, among those the fragment lists, each under its number in `<q>`. */
function shipmentOf($: CheerioAPI, body: string, number: string): Cheerio<Element> {
  const accordion = $('fieldset > div.accordion');
  if (accordion.length !== 1) notFragment(body);
  const groups = accordion.children('div.accordion-group');
  if (!groups.length) {
    // The fragment's answer for a number it holds nothing under: the accordion and nothing in it.
    if (!clean(accordion.text())) throw new NotFoundError(PROVIDER, `${PROVIDER} has no shipment under this number`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid shipment list`);
  }
  if (groups.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized shipment list`);
  const own = groups.toArray().find((group) => normalizeTrackingNumber(clean($(group).find('.accordion-heading q').first().text(), 64)) === number);
  if (!own) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  return $(own);
}

/** YTO, under the number asked, when YTO's rules take it: the courier that delivers the parcel in China. */
function ytoHandoff(number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  return (detectCarrierMatch(number).candidates as string[]).includes('yto') ? { delivery_carrier: 'yto', delivery_tracking_number: number } : {};
}

/**
 * Qunhang's history for one shipment, newest first: the fragment of
 * `_track.jsp?oids=<number>`, one accordion group per shipment, headed by its origin country and its
 * number, with its rows oldest first. Qunhang's own rows (transport, customs, clearance) come first,
 * to the minute, then the rows of YTO, which delivers the parcel in China under the same waybill, to
 * the second. Every clock is China's. The operator's contact, couriers, phones and hotlines are left out.
 */
export function parseQunhang(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeQunhangNumber(raw);
  const $ = load(body);
  const shipment = shipmentOf($, body, number);
  const items = shipment.find('blockquote ul > li').toArray();
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const item of items) {
    const label = $(item).children('label');
    if (label.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    const local = wallClock(label.text());
    const text = qunhangText($(item).clone().children('label').remove().end().text());
    if (!text) continue;
    const cleared = CLEARED_AT.exec(text);
    const description = cleared ? clean(text.slice(0, cleared.index), 300) || text : text;
    const location = cleared ? cleared[1]! : STATION.map((pattern) => clean(pattern.exec(text)?.[1], 30)).find(Boolean) ?? '';
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const staged = qunhangStage(description);
    events.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(description !== text ? { original_description: text } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The fragment lists the rows oldest first.
  events.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const origin = countryCode(clean(shipment.find('.accordion-heading .title-label').first().text(), 40));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    ...(origin && origin !== 'CN' ? { origin_country: origin } : {}),
    destination_country: 'CN',
    ...ytoHandoff(number),
    events,
  };
}
