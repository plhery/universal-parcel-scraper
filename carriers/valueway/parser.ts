import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { canadaProvinceTimeZone } from '../../core/time/index.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { statusMap, valuewayStage } from './status.js';

export const PROVIDER = 'Valueway Express';
export const CARRIER = 'valueway';
/** Valueway Express's tracking server, where its site's form goes. */
export const VALUEWAY_API = 'https://member.valueway.net/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const VALUEWAY_SITE = 'https://www.valueway.net/main.html';
// The tracking page is some fifty kilobytes.
export const VALUEWAY_PAGE_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit, as the site's form asks.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;

const HOME = 'America/Toronto';
const CHINA = 'Asia/Shanghai';
const HONG_KONG = 'Asia/Hong_Kong';
// The towns of Valueway's offices and warehouses, as its rows write them in Chinese or English.
const OFFICES: Readonly<Record<string, string>> = {
  多伦多: HOME, 士嘉堡: HOME, 万锦: HOME, 蒙特利尔: HOME, 卡尔加里: 'America/Edmonton', 温哥华: 'America/Vancouver',
  toronto: HOME, scarborough: HOME, markham: HOME, montreal: HOME, calgary: 'America/Edmonton', vancouver: 'America/Vancouver',
};
// "Toronto,ON,Canada": a town, its province and the country.
const CANADIAN_PLACE = /^[^,]{1,60},\s*([A-Z]{2})\s*,\s*Canada$/i;
// The forwarding warehouse's rows: 中转仓揽收成功, 中转仓出库成功.
const WAREHOUSE = /^\s*中转仓/u;

// A domestic courier's row as Valueway copies it, its city or point in brackets first: "[长沙市]…", "【深圳市】…".
const DOMESTIC = /^\s*[[【](\p{Script=Han}[^\]】]{0,11})[\]】]\s*/u;
const CITY = /^\p{Script=Han}{2,10}[市县]$/u;
const ROLE = '快递员|派送员|揽收员|收派员|业务员|小哥';
// A person named before their phone: "-<name>（<phone>）", "快递员 <name>（<phone>）", "快递员<name>，联系电话…".
const NAMED = new RegExp(`(?:[-－]\\s*|(${ROLE})[:：]?\\s*)\\p{Script=Han}{1,4}`
  + '(?=\\s*(?:[（(\\[【]\\s*[\\d*\\- ]{7,20}\\s*[）)\\]】]|[，,]\\s*(?:联系电话|联系方式|手机)|1[3-9]\\d{9}))', 'gu');
// The person a parcel was handed to or signed by: "快件交给<name>，", "由<name>签收".
const HANDED = /(交给)[^，,。；;（(]{1,12}(?=[，,])/gu;
const SIGNATORY = /由[^，,。；;【】（(]{1,20}(签收|代收)/gu;
// An aside in brackets: a phone, who signed, a piece count or a notice.
const ASIDE = /[（(][^（()）]*[）)]/gu;
// A phone or a call line in square brackets.
const DIGITS = /[[【][^\]】]*\d{5,}[^\]】]*[\]】]/gu;
// Where a courier's or a recipient's details start: the wording stops before them.
const CONTACT = /如有疑问|联系电话|联系方式|投诉电话|电话|手机|地址[:：]|签收人|1[3-9]\d{9}|\d{3,4}-\d{7,8}/u;
// A parcel left at a pickup point names it, which can be the recipient's building: the wording stops at the verb.
const STORED = /(暂存|存放|放)(?:至|于|在)/u;
const SENTENCE_END = /[。！!]/u;

/** A waybill on Valueway's tracker, without spaces or hyphens. */
export function normalizeValuewayNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Valueway Express waybills are 8 to 30 letters and digits');
  return number;
}

/** A domestic courier's sentence, without the people it names, their phones, a pickup point or notes. */
export function domesticWording(text: string): string {
  let kept = text.replace(NAMED, (_match, role: string | undefined) => role ?? '').replace(HANDED, '$1')
    .replace(SIGNATORY, '$1').replace(ASIDE, '').replace(DIGITS, '');
  for (const end of [CONTACT, SENTENCE_END]) {
    const at = kept.search(end);
    if (at >= 0) kept = kept.slice(0, at);
  }
  const stored = STORED.exec(kept);
  if (stored) kept = kept.slice(0, stored.index + stored[1]!.length);
  return kept.replace(/[\s，,；;：:、【[]+$/u, '').trim();
}

/**
 * A row's wording. Valueway's own rows are kept as written. A domestic courier's row, which
 * the tracker copies after customs with its city in brackets first, gives that city as the
 * place and keeps its sentence without the courier's or the signatory's name and phone.
 */
export function valuewayRow(info: string): GinfoRowText {
  const domestic = DOMESTIC.exec(info);
  if (!domestic) return { description: info };
  return { description: domesticWording(info.slice(domestic[0].length)), ...(CITY.test(domestic[1]!) ? { location: domestic[1]! } : {}) };
}

/** The zone of a place a row names: a Canadian office's town, or a place in China or Hong Kong. */
function placeZone(place: string): string | null {
  const canadian = CANADIAN_PLACE.exec(place);
  if (canadian) return canadaProvinceTimeZone(canadian[1]);
  if (/^(?:中国)?香港/u.test(place)) return HONG_KONG;
  if (/^中国/u.test(place)) return CHINA;
  const town = place.trim().toLowerCase();
  return Object.hasOwn(OFFICES, town) ? OFFICES[town]! : null;
}

/**
 * The clock a row is written on. A row placed in Canada is on its town's clock and one placed in
 * China on China's. The domestic courier's rows are on China's clock, or Hong Kong's. The
 * forwarding warehouse's system writes China's clock wherever the warehouse is: its departure
 * scan reads hours before the Toronto hub's on that clock, and hours after it on Toronto's.
 * Valueway's other rows are on its own clock, Toronto's.
 */
export function valuewayZone(place: string, info: string): GinfoRowZone {
  const placed = placeZone(place);
  if (placed) return { zone: placed, basis: 'place' };
  const domestic = DOMESTIC.exec(info);
  if (domestic) return { zone: domestic[1]!.includes('香港') ? HONG_KONG : CHINA, basis: 'place' };
  return { zone: WAREHOUSE.test(info) ? CHINA : HOME, basis: 'carrier' };
}

/**
 * Valueway Express's tenant of the GInfo server. Its page shows STATE 3 as
 * delivered (送达！) with ADATE as the delivery time. Its rows mix Toronto's
 * and China's clocks, so each row is dated on its own.
 */
export const VALUEWAY: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: VALUEWAY_API, site: VALUEWAY_SITE, normalize: normalizeValuewayNumber,
  stage: valuewayStage, statusMap, row: valuewayRow, zone: valuewayZone, deliveredState: true,
};

/**
 * A record without the delivery carrier the shared reader takes from `REFER_NBR`: Valueway writes
 * a note there, or a number from before the parcel reached it. Its page names the delivery carrier.
 */
export function withoutReference(record: CarrierResult): CarrierResult {
  const result = { ...record };
  delete result.delivery_carrier;
  delete result.delivery_tracking_number;
  return result;
}

/** The record Valueway's tracker returns for one number. */
export const parseValueway = (body: string, raw: string, readAt?: number): CarrierResult => withoutReference(parseGinfo(VALUEWAY, body, raw, readAt));

/** The tracking page the site's form opens for one number. */
export function valuewayPageUrl(number: string): string {
  return `${VALUEWAY_API}?${new URLSearchParams({ MfcISAPICommand: 'EmmisTrack', w: 'valueway', ntype: '1000', cmodel: 'new:tracking', cno: number })}`;
}

// The catalog carrier each courier key in the page's `cKey` names.
const TRANSFERS: Readonly<Record<string, string>> = { 'KD100-shunfeng': 'sf-express' };
const REFERENCE = /^[A-Z0-9]{8,40}$/;

/** The one value the page's script gives a variable, or null. */
function pageVariable(page: string, name: string): string | null {
  const values = [...page.matchAll(new RegExp(`\\bvar ${name}='([^'\\r\\n<>]{0,80})';`, 'g'))];
  return values.length === 1 ? values[0]![1]! : null;
}

/**
 * The domestic courier and its number the tracking page's script names, for
 * the waybill it was opened for: `cKey` the courier's key, `cNo` its number,
 * `cNum` the waybill. The key can name SF Express for another courier's
 * number, so SF Express is the delivery carrier only when its own rules claim
 * the whole number.
 */
export function valuewayHandoff(page: string, raw: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const number = normalizeValuewayNumber(raw);
  if (normalizeTrackingNumber(pageVariable(page, 'cNum') ?? '') !== number) return {};
  const keys = (pageVariable(page, 'cKey') ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const numbers = (pageVariable(page, 'cNo') ?? '').split(',').map((value) => normalizeTrackingNumber(value)).filter(Boolean);
  const carrier = keys.length === 1 && Object.hasOwn(TRANSFERS, keys[0]!) ? TRANSFERS[keys[0]!] : undefined;
  const onward = numbers.length === 1 ? numbers[0]! : '';
  if (!carrier || !REFERENCE.test(onward) || onward === number) return {};
  const match = detectCarrierMatch(onward);
  return match.confidence === 'high' && match.carrier === carrier ? { delivery_carrier: carrier, delivery_tracking_number: onward } : {};
}
