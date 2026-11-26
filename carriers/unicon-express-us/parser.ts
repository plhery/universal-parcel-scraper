import { load } from 'cheerio';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, uniconStage } from './status.js';

export const PROVIDER = 'unicon-express-us';
// A result page is about 20 kB, most of it the site's chrome.
export const UNICON_MAX_BYTES = 512 * 1024;

// LH and ten digits.
const NUMBER = /^LH\d{10}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// "未找到 LH… 相关信息!": the only row of a number the tracker does not know.
const NOT_FOUND = /^未找到\s*(\S{1,64})\s*相关信息[!！]?$/;
// A domestic courier's row opens with its city: "[北京市]".
const CITY = /^\[([^[\]]{1,30})\]\s*/;
// "包裹派送中，已转顺丰速运快递，快递单号为SF…": the courier in China and the number it delivers under.
const HANDOFF = /已转\s*(\p{Script=Han}{2,10}?)\s*(?:快递)?\s*[，,]\s*快递单号为\s*([A-Z0-9]{6,40})$/u;
// The couriers UNICON has been seen handing parcels to, by the name its row gives them.
const COURIERS: Readonly<Record<string, string>> = { 顺丰速运: 'sf-express' };
const MAX_ROWS = 300;

// Bracketed words that give a contact: a phone label, a phone number or a courier's role.
const CONTACT_BRACKET = /[【（(]([^【】（）()]{0,160})[】）)]/g;
const CONTACT = /(?:电话|手机|联系方式)\s*[:：]|\d{7,}|快递员|快递小哥|派件员|收派员|配送员|投递员|揽投员|揽收员|业务员|签收人/;
// A courier or signer named after a colon: "投递员：…", "签收人是：…".
const NAMED = /(?:快递员|快递小哥|派件员|收派员|配送员|投递员|揽投员|揽收员|业务员|签收人)\s*(?:是)?\s*[:：]\s*[^，,。；;！!（）()【】\s]{1,20}/g;
// SF's round: "快件交给<courier>，正在派送途中".
const HANDED_TO = /交给[^，,。；;！!（）()【】\s]{1,12}\s*[，,]\s*(?=正在派送)/g;
// The line asking to call the courier, once the courier's bracket is gone.
const CALL_COURIER = /[，,]?\s*如有疑问请(?:电联|联系|致电)[^，,。；;！!]{0,20}/g;
// A run of seven or more digits, with spaces or hyphens between them, as phone numbers are written; a
// waybill after 单号 stays.
const PHONE = /(?<![A-Z\d])(?<!单号(?:为|是)?\s*[:：]?\s*)\+?\d(?:[\s-]?\d){6,}(?![A-Z\d])/gi;
// A phone label left without its number.
const BARE_LABEL = /[，,]?\s*(?:联系)?(?:电话|手机)\s*[:：]?\s*(?=[，,。；;！!]|$)/g;

/** A UNICON waybill: LH and ten digits. */
export function normalizeUniconNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'UNICON Express USA waybills are LH and ten digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * A row's wording without the courier's name or phone number: brackets that give a contact,
 * a courier named after a colon or handed the round, the line asking to call the courier and
 * any phone number left, with its label.
 */
export function uniconText(value: string): string {
  const text = value
    .replace(CONTACT_BRACKET, (whole, inner: string) => (CONTACT.test(inner) ? '' : whole))
    .replace(NAMED, '')
    .replace(HANDED_TO, '')
    .replace(CALL_COURIER, '')
    .replace(PHONE, '')
    .replace(BARE_LABEL, '');
  return clean(text)
    .replace(/([，,。；;])\s*[，,。；;]+/g, '$1')
    .replace(/^[\s，,。；;:：]+|[\s，,；;:：]+$/g, '');
}

function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  const iso = date && clock ? calendarDay(Number(date[1]), Number(date[2]), Number(date[3])) : null;
  if (!iso || Number(date![1]) < 2000) return invalid('UNICON returned an invalid row time');
  return `${iso}T${clock![1]}:${clock![2]}:00`;
}

/** The courier in China and its number, from the newest row that names them. */
function handoffOf(events: readonly CarrierEvent[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const event of events) {
    const match = HANDOFF.exec(event.description ?? '');
    if (!match) continue;
    const number = normalizeTrackingNumber(match[2]!);
    const courier = COURIERS[match[1]!];
    // The number is the courier's only when that courier's rules offer it.
    const named = courier !== undefined && (detectCarrierMatch(number).candidates as readonly string[]).includes(courier);
    return { ...(named ? { delivery_carrier: courier } : {}), delivery_tracking_number: number };
  }
  return {};
}

/**
 * The tracker's page for one waybill, `index.php?s=/Index/chaxun&sn=`, which its server
 * renders: the number asked in its search box, then a table of rows newest first, each a
 * day, a minute and a wording. UNICON's own rows, from the warehouse in the United States to
 * Chinese customs, name no place; the rows of the courier it hands the parcel to in China
 * open with their city in []. A number the tracker does not know gets one row,
 * `未找到 <number> 相关信息!`.
 */
export function parseUnicon(html: string, raw: string): CarrierResult {
  const number = normalizeUniconNumber(raw);
  if (typeof html !== 'string' || !html) return invalid('UNICON returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'UNICON answered with a browser check');
  const $ = load(html);
  const box = $('input#order_sn');
  const table = $('div.detailBox table.result-info');
  if (box.length !== 1 || table.length !== 1) return invalid('UNICON returned a page without its tracking result');
  if (normalizeTrackingNumber(clean(box.attr('value'), 80)) !== number) {
    throw new IndeterminateError(PROVIDER, 'UNICON answered for another waybill');
  }
  const rows = table.find('tr').toArray();
  if (rows.length > MAX_ROWS) return invalid('UNICON returned too many rows');
  const notice = rows.length === 1 ? NOT_FOUND.exec(clean($(rows[0]).text(), 120)) : null;
  if (notice) {
    if (normalizeTrackingNumber(notice[1]!) !== number) throw new IndeterminateError(PROVIDER, 'UNICON answered for another waybill');
    throw new NotFoundError(PROVIDER, 'UNICON has no information under this waybill');
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'UNICON lists the waybill without a row', { reason: 'listed' });

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = $(row);
    const day = cells.find('td.row1 span.day');
    const time = cells.find('td.row1 span.time');
    const context = cells.find('td.context');
    if (day.length !== 1 || time.length !== 1 || context.length !== 1) return invalid('UNICON returned an unreadable row');
    const local = wallClock(clean(day.text(), 20), clean(time.text(), 20));
    const text = clean(context.text(), 600);
    const city = CITY.exec(text);
    const description = uniconText(city ? text.slice(city[0].length) : text);
    if (!description) return invalid('UNICON returned a row without its wording');
    const staged = uniconStage(description);
    const event: CarrierEvent = {
      local_time: local, description,
      ...(city ? { location: city[1]!.trim() } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const key = JSON.stringify([local, description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  // The tracker's order stands: newest first.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...handoffOf(events),
    events,
  };
}
