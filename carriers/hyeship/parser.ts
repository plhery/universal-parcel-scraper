import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/text.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { hyeshipStage, statusMap } from './status.js';

export const PROVIDER = 'Hongyuan Express';
export const CARRIER = 'hyeship';
/** Hongyuan Express's tracking server, which its site's tracking page asks. */
export const HYESHIP_API = 'https://www.hyeship.com/cgi-bin/GInfo.dll';
/** The site whose tracking page opens the server's record. */
export const HYESHIP_SITE = 'https://www.hyeship.com/track/';
// Letters and digits, with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const HOME = 'America/Los_Angeles';
const CHINA = 'Asia/Shanghai';
// The firm's warehouse in Los Angeles, where it takes parcels in and sends them off.
const WAREHOUSE = /^鸿远(?:发货)?仓库$/u;
const CHINA_PLACE = /中国|China/iu;
// The domestic courier's sentences the tracker relays under the firm's name: an arrival at a site, the signature.
const RELAYED = /^(?:到达\s*[:：]|已签收)/u;
const SIGNED = /^已签收/u;
// A phone: a mobile, a landline with its area code, a hotline.
const PHONE = /(?<![\d-])(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|95\d{3,4}|400-?\d{3}-?\d{4})(?![\d-])/gu;
// A courier named with a phone in brackets: "指定：<name>(<mobile>)派送".
const NAMED = new RegExp(String.raw`[^\s:：，,。()（）]{1,10}\s*[（(]\s*(?:${PHONE.source})\s*[)）]`, 'gu');
// A pickup point near the recipient, whose name can give their street or building: only its kind is kept.
const PICKUP_POINT = /[^\s:：，,。()（）]*?(寄存点|驿站|代收点|自提点|快递柜|丰巢|超市)[^\s:：，,。()（）]*/gu;
const PICKUP = /寄存点|驿站|代收点|自提点|快递柜|丰巢|超市/u;
// A label the sentence leaves empty: "… 发往：".
const EMPTY_LABEL = /\s*(?:发往|上级站点|指定)\s*[:：]\s*$/u;

/** A waybill on Hongyuan Express's tracker, without spaces or hyphens. */
export function normalizeHyeshipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hongyuan Express waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * A row's wording. The domestic courier's sentences, which the tracker relays under the firm's name, name
 * the delivering courier with a mobile, the pickup point and who signed: the signature reads 已签收 alone,
 * the courier and the phones are left out, and a pickup point keeps only its kind.
 */
export function hyeshipRow(info: string): GinfoRowText {
  if (SIGNED.test(info)) return { description: '已签收' };
  const text = info.replace(NAMED, '').replace(PHONE, '').replace(/指定\s*[:：]\s*派送/u, '指定派送')
    .replace(PICKUP_POINT, '$1').replace(EMPTY_LABEL, '');
  return { description: clean(text, 300) };
}

/** A row's place, or '' for a pickup point, whose name can give the recipient's street or building. */
export function hyeshipPlace(place: string): string {
  return PICKUP.test(place) ? '' : place;
}

/**
 * The clock a row is written on. The Los Angeles warehouse's rows are on Pacific time; a row that names
 * China, and the domestic courier's sentences, which name its sites in China, are on China's clock. A row
 * that says neither keeps its wall clock.
 */
export function hyeshipZone(place: string, info: string): GinfoRowZone | null {
  if (CHINA_PLACE.test(`${place} ${info}`)) return { zone: CHINA, basis: 'place' };
  if (WAREHOUSE.test(place)) return { zone: HOME, basis: 'carrier' };
  if (RELAYED.test(info)) return { zone: CHINA, basis: 'destination' };
  return null;
}

/** Hongyuan Express's tenant of the GInfo server, which answers in GBK. */
export const HYESHIP: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: HYESHIP_API, site: HYESHIP_SITE, normalize: normalizeHyeshipNumber,
  stage: hyeshipStage, statusMap, row: hyeshipRow, place: hyeshipPlace, zone: hyeshipZone, encoding: 'gb18030',
};

/** The record Hongyuan Express's tracker returns for one number, decoded. */
export const parseHyeship = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(HYESHIP, body, raw, readAt);
