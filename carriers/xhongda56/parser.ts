import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { statusMap, xhongda56Stage } from './status.js';

export const PROVIDER = 'Xinhongda Logistics';
export const CARRIER = 'xhongda56';
/** Xinhongda's tracking server, where its site's form posts. */
export const XHONGDA56_API = 'http://www.xhongda56.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const XHONGDA56_SITE = 'http://www.xhongda56.com/';
// Letters and digits, with a digit: seven digits on the samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const HOME = 'Asia/Shanghai';
// A member of staff a row names in brackets: "揽件员是【…】", "派件员是【…】".
const STAFF = /[,，]?\s*(?:扫描员|收件员|揽件员|揽收员|派件员|派送员|快递员|操作员|司机|签收人)\s*(?:是|为)?\s*[:：]?\s*【[^【】]*】/gu;
// Anything else that names a person or a phone, "签收人 …" or "签收人:…": the wording stops before it.
const CONTACT = /签收人|收件人|联系人|揽件员|派件员|快递员|(?:联系)?(?:电话|手机)(?:号码?)?[:：]?\s*\d|1[3-9]\d{9}|\d{3,4}-\d{7,8}/u;
const BRACKET = /【([^【】]{1,60})】/u;

/** A waybill on Xinhongda's tracker, without spaces or hyphens. */
export function normalizeXhongda56Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Xinhongda Logistics waybills are 6 to 30 letters and digits');
  return number;
}

/** A row's wording, without the staff who collected or delivered the parcel, the person who signed, or a phone. */
export function xhongda56Row(info: string): GinfoRowText {
  const text = info.replace(STAFF, '');
  const contact = CONTACT.exec(text);
  return { description: (contact ? text.slice(0, contact.index) : text).replace(/[\s,，；;：:]+$/u, '').trim() };
}

/**
 * The place of a row: the first station its sentence names in brackets, where the parcel was
 * collected, arrived or left from, else `PLACE`. On the bracketed sentences `PLACE` holds the next
 * stop or the destination station instead.
 */
export function xhongda56Place(place: string, info: string): string {
  return BRACKET.exec(info)?.[1] ?? place;
}

/** Every row is written in China by Xinhongda's network, on China's clock. */
export function xhongda56Zone(): GinfoRowZone {
  return { zone: HOME, basis: 'carrier' };
}

/** Xinhongda's tenant of the GInfo server, which answers in GBK. */
export const XHONGDA56: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: XHONGDA56_API, site: XHONGDA56_SITE, normalize: normalizeXhongda56Number,
  stage: xhongda56Stage, statusMap, row: xhongda56Row, place: xhongda56Place, zone: xhongda56Zone, encoding: 'gb18030',
};

/** The record Xinhongda's tracker returns for one number, decoded. */
export const parseXhongda56 = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(XHONGDA56, body, raw, readAt);
