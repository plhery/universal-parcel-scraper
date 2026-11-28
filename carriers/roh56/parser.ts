import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { roh56Stage, statusMap } from './status.js';

export const PROVIDER = 'Ronghui Supply Chain';
export const CARRIER = 'roh56';
/** Ronghui's tracking server, where its site's form posts. */
export const ROH56_API = 'http://www.roh56.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const ROH56_SITE = 'http://www.roh56.com/';
// Letters and digits, with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const HOME = 'Asia/Shanghai';
// A member of staff a row names in brackets: "扫描员是【…】", "派件员是【…】", "签收人是【…】".
const STAFF = /[,，]?\s*(?:扫描员|收件员|派件员|揽收员|快递员|操作员|司机|签收人)\s*(?:是|为)?\s*[:：]?\s*【[^【】]*】/gu;
// Anything else that names a phone: the wording stops before it.
const CONTACT = /(?:联系)?(?:电话|手机)(?:号码?)?[:：]?\s*\d|1[3-9]\d{9}|\d{3,4}-\d{7,8}/u;

/** A waybill on Ronghui's tracker, without spaces or hyphens. */
export function normalizeRoh56Number(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Ronghui Supply Chain waybills are 8 to 30 letters and digits');
  return number;
}

/** A row's wording, without the staff who scanned, delivered or signed for the parcel, or a phone. */
export function roh56Row(info: string): GinfoRowText {
  const text = info.replace(STAFF, '');
  const contact = CONTACT.exec(text);
  return { description: (contact ? text.slice(0, contact.index) : text).replace(/[\s,，；;：:]+$/u, '').trim() };
}

/** Every row is written in China by Ronghui's network, on China's clock. */
export function roh56Zone(): GinfoRowZone {
  return { zone: HOME, basis: 'carrier' };
}

/**
 * Ronghui's tenant of the GInfo server, which answers in GBK. Its page shows
 * STATE 3 as delivered (送达！) with ADATE as the delivery time.
 */
export const ROH56: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: ROH56_API, site: ROH56_SITE, normalize: normalizeRoh56Number,
  stage: roh56Stage, statusMap, row: roh56Row, zone: roh56Zone, deliveredState: true, encoding: 'gb18030',
};

/** The record Ronghui's tracker returns for one number, decoded. */
export const parseRoh56 = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(ROH56, body, raw, readAt);
