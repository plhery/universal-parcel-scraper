import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { wanjiaStage } from './status.js';

export const PROVIDER = 'Wanjia Logistics';
/** The site's 货物追踪 page, whose script frames the page below for the waybill typed in. */
export const WANJIA_PAGE = 'http://www.manco-logistics.com/h-col-122.html';
export const WANJIA_ENDPOINT = 'http://cn.manco-logistics.com:8606/WangJTaoBaoInterface/wjwl/query.do';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const ROW = /<div class="tracking-item">\s*<div class="tracking-icon status-[a-z]+">\s*<svg[\s\S]{0,2000}?<\/svg>(?:<!--[\s\S]{0,120}?-->)?\s*<\/div>\s*(?:<!--[\s\S]{0,200}?-->\s*)?<div class="tracking-date"><span>(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)<\/span><\/div>\s*<div class="tracking-content">([^<]{0,800})<span><\/span>\s*<\/div>\s*<\/div>/g;

/** The waybills on kuaidi.com's Wanjia page are fourteen digits. */
export function normalizeWanjiaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{14}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Wanjia waybills are fourteen digits');
  return number;
}

export function wanjiaLookupUrl(number: string): string {
  return `${WANJIA_ENDPOINT}?${new URLSearchParams({ nu: number })}`;
}

/** The region a row opens with, as [陕西省,咸阳市], named as one place: 咸阳市, or 天津市宁河区. */
function region(parts: string): string {
  const [first, second] = parts.split(/[,，]/).map(part => part.trim());
  if (!second) return first!;
  return /(?:省|自治区)$/.test(first!) ? second : `${first}${second}`;
}

/**
 * A row's wording without the pickup code, couriers, collectors, phone numbers or the lines
 * telling the recipient to call Wanjia or the merchant. A partner's waybill for the last leg stays.
 */
function wording(content: string): string {
  return content
    .replace(/[（(]如若联系不上[^)）]{0,40}[)）]/g, '')
    .replace(/查件电话[:：][\d\-—,，、\s]{0,60}/g, '')
    .replace(/[，,]*可关注“[^”]{1,12}”官方微信公众号获取实时物流信息/g, '')
    .replace(/[，,]*如有疑问请联系站点[^(（]{0,40}?处理更快捷/g, '')
    .replace(/[（(][^)）]{0,60}(?:呼叫|投诉)[^)）]{0,60}[)）]/g, '')
    .replace(/的快递员[（(][^)）]{0,30}[)）]/g, '的快递员')
    .replace(/已由快递员\p{Script=Han}{2,4}送达/gu, '已送达')
    .replace(/(】|服务点|网点|分部)的\p{Script=Han}{2,4}\s*(?=已揽收|正在为您派)/gu, '$1')
    .replace(/[，,]\s*揽收人[:：]\s*\p{Script=Han}{2,4}/gu, '')
    .replace(/已为您转(\p{Script=Han}{2,8}?)([A-Z]{0,4}\d{8,20})派送单号/u, '已转$1$2派送')
    .replace(/[（(]0\d{9,11}[)）]/g, '')
    .replace(/1[3-9]\d{9}|0\d{2,3}-\d{7,8}/g, '')
    .replace(/[（(]\s*[。.]?\s*[)）]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,]\s*(?=[，,。])/g, '')
    .replace(/^[\s，,]+|[\s，,:：;；]+$/g, '')
    .trim();
}

/** The scan a row's wording is built around, as 已揽收 or 发往. */
function code(description: string): string | undefined {
  if (/已签收/.test(description)) return '已签收';
  if (/已领取/.test(description)) return '已领取';
  if (/暂存/.test(description)) return '暂存';
  if (/请及时取件/.test(description)) return '待取件';
  if (/正在为您派(?:件|送)/.test(description)) return '派件';
  if (/已揽收/.test(description)) return '已揽收';
  if (/^（经转）/.test(description)) return '经转';
  if (/发往/.test(description)) return '发往';
  if (/到达|抵达/.test(description)) return '到达';
  return undefined;
}

/**
 * The tracking page for one waybill: a heading naming it, then its scans newest first on China
 * wall clocks. The heading must be the whole waybill asked; a page saying it found nothing is a
 * waybill Wanjia does not know. Wanjia hands its parcels to national networks, whose scans fill
 * the history; a row opens with the region it happened in, which is its location.
 */
export function parseWanjia(html: string, raw: string): CarrierResult {
  const number = normalizeWanjiaNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Wanjia returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Wanjia answered with a browser check');
  const headings = [...html.matchAll(/<h5>单号：([^<]{1,40})<\/h5>/g)].map(match => match[1]!.trim());
  if (headings.length !== 1 || headings[0] !== number) throw new SchemaError(PROVIDER, 'Wanjia returned another waybill');
  const start = html.indexOf('<div class="tracking-list">');
  if (start < 0) throw new SchemaError(PROVIDER, 'Wanjia returned a waybill without its scan list');
  const list = html.slice(start);
  const rows = [...list.matchAll(ROW)];
  if (rows.length > 500 || rows.length !== (list.match(/<div class="tracking-item">/g)?.length ?? 0)) {
    throw new SchemaError(PROVIDER, 'Wanjia returned an invalid scan row');
  }
  if (!rows.length) {
    if (/<div class="result-not-found">/.test(list)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Wanjia returned a waybill without scans');
  }
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, year, month, day, clock, content] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    if (!date) throw new SchemaError(PROVIDER, 'Wanjia returned an invalid scan time');
    let text = textFromHtml(content!, 800).replace(/取件码[:：][^;；[]{0,40}[;；]?/g, '');
    let place: string | undefined;
    const opening = /^\[([^\]]{1,40})\]/.exec(text);
    if (opening) {
      place = region(opening[1]!);
      text = text.slice(opening[0].length);
      // The city the region named, bracketed again.
      const city = opening[1]!.split(/[,，]/).at(-1)!.trim();
      text = text.replace(`【${city}】`, '');
    } else {
      const named = /^【([^】]{1,20})】(?!的)/.exec(text);
      if (named) { place = named[1]; text = text.slice(named[0].length); }
    }
    const description = wording(text);
    if (!description) continue;
    const type = code(description), stage = type ? wanjiaStage(type) : undefined;
    const event: CarrierEvent = { local_time: `${date}T${clock}`, description, ...(type ? { provider_code: type } : {}),
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // The page lists scans newest first; rows on the same clock keep its order.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof wanjiaStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 300) };
}
