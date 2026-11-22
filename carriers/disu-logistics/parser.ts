import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { disuStage } from './status.js';

export const PROVIDER = 'Disu Logistics';
/** The site's home page, whose tracking box calls the endpoint below; the site answers over HTTP only. */
export const DISU_PAGE = 'http://www.d-exp.cn/';
export const DISU_ENDPOINT = 'http://www.d-exp.cn/Home/TraceinfoQuery';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const ROW = /<li(?: class='first')?><i class='node-icon'><\/i><span class='time'>(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):([0-5]\d):([0-5]\d)<\/span><span class='txt'>([^<]{0,800})<\/span><\/li>/g;

/** The shapes the site's own script accepts: twelve digits, 6 and fourteen digits, or DS and fifteen digits. */
export function normalizeDisuNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:\d{12}|6\d{14}|DS\d{15})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Disu waybills are twelve digits, 6 and fourteen digits, or DS and fifteen digits');
  return number;
}

export function disuLookupUrl(number: string): string {
  return `${DISU_ENDPOINT}?${new URLSearchParams({ billcode: number })}`;
}

/** The scans the rows stand for, matched in this order on the wording without its brackets. */
const CODES: readonly (readonly [RegExp, string])[] = [
  [/送达签收|已签收/, '签收'],
  [/暂存/, '暂存'],
  [/再次派送/, '再次派送'],
  [/正在为您派送/, '派送'],
  [/准备分配快递员/, '到达站点'],
  [/^预计.{0,20}到达/, '预计到达'],
  [/已出.{0,4}(?:正在|即将)发往/, '发出'],
  [/开始分拣/, '分拣'],
  [/揽收完成|收货$/, '揽收'],
];

/**
 * A row's wording without its leading place, the customer service notices, the courier, the
 * signatory and the phone numbers. A pickup point and the delivering partner's waybill stay.
 */
function wording(text: string): string {
  return text
    .replace(/^【[^】]{1,40}】/, '')
    .replace(/[【（(]如有问题请拨打速递官方客服[^】）)]{0,40}[】）)]/g, '')
    .replace(/[，,]?\s*物流问题无需找商家或平台[^。]{0,40}。?/g, '')
    .replace(/【[，,]】有取件码问题[^【]{0,40}请联系快递员【[^】]{0,60}】/g, '')
    .replace(/[，,]?\s*如有疑问(?:您可以)?(?:请)?联系(?:快递员)?(?:【[^】]{0,60}】|\d{7,})/g, '')
    .replace(/快递员【[^】]{0,60}】/g, '快递员')
    .replace(/[，,]由[^，,]{1,10}签收/g, '')
    .replace(/[，,]\s*请您通过该单号查件并签收/g, '')
    .replace(/1[3-9]\d{9}|956160/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,，。.]+$/, '')
    .trim();
}

/** A row's leading place, as 深圳市, or the city of 广东省-茂名市. */
function place(text: string): string | undefined {
  const bracket = /^【([^】]{1,40})】/.exec(text)?.[1];
  return bracket?.replace(/^[一-鿿]{2,8}(?:省|自治区)-/, '');
}

/**
 * The tracker's reply for one waybill: a heading naming it, then its scans newest first on China
 * wall clocks. The heading must name the whole waybill asked; an unknown waybill comes back with the
 * heading and no scans.
 */
export function parseDisu(html: string, raw: string): CarrierResult {
  const number = normalizeDisuNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Disu returned an empty reply');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Disu answered with a browser check');
  const headings = [...html.matchAll(/<p class='sear_num'>运单号：【([^】<]{1,40})】<\/p>/g)].map(match => match[1]!.trim().toUpperCase());
  if (!headings.length) throw new SchemaError(PROVIDER, 'Disu returned a reply without its tracking results');
  if (headings.length !== 1 || headings[0] !== number) throw new SchemaError(PROVIDER, 'Disu returned another waybill');
  const rows = [...html.matchAll(ROW)];
  if (rows.length > 500 || rows.length !== (html.match(/<li[ >]/g)?.length ?? 0)) throw new SchemaError(PROVIDER, 'Disu returned an invalid scan row');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const events: CarrierEvent[] = [], seen = new Set<string>();
  let delivery: string | undefined;
  for (const [, year, month, day, hour, minute, second, body] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    if (!date || +hour! > 23) throw new SchemaError(PROVIDER, 'Disu returned an invalid scan time');
    const text = textFromHtml(body, 800), description = wording(text);
    if (!description) continue;
    delivery ??= /代派单号[:：]\s*(\d{8,20})/.exec(description)?.[1];
    const bare = description.replace(/【[^】]*】/g, ''), type = CODES.find(([pattern]) => pattern.test(bare))?.[1];
    const stage = type ? disuStage(type) : undefined, location = place(text);
    const event: CarrierEvent = { local_time: `${date}T${hour!.padStart(2, '0')}:${minute}:${second}`, description,
      ...(type ? { provider_code: type } : {}), ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // The reply lists rows newest first; rows on the same clock keep its order.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events[0]!;
  const stage = newest.stage as ReturnType<typeof disuStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.location ? `${newest.description} · ${newest.location}` : newest.description,
    last_update: null, last_update_local: newest.local_time, ...(delivery ? { delivery_tracking_number: delivery } : {}), events: events.slice(0, 200) };
}
