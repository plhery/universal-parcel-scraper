import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { GINFO_MAX_BYTES, parseGinfo, type GinfoRowText, type GinfoTenant } from '../hgd/ginfo.js';
import { kingDeliveryStage, statusMap } from './status.js';

export const PROVIDER = 'King Delivery';
export const CARRIER = 'king-delivery';
export const KING_DELIVERY_MAX_BYTES = GINFO_MAX_BYTES;
/** King Delivery's tracking server, where its site's form goes. */
export const KING_DELIVERY_API = 'https://www.kuaidaexp.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const KING_DELIVERY_SITE = 'https://www.kuaidaexp.com/';
// Letters and digits, with a digit: the tracker takes the numbers of the networks King Delivery ships on.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// A courier's name and phone after their role, "快递员<name>，联系电话<phone>", or the same in brackets.
const COURIER = /([（(])?(快递员|揽收员|派送员|配送员|快递小哥)[:：]?\s*[^\s，,。；;：:（()）【】]{1,4}[，,]\s*(?:联系电话|联系方式|手机(?:号码?)?)[:：]?\s*[\d*\- ]{6,20}\d[）)]?/gu;
// A signatory, "由<name>签收".
const SIGNATORY = /由[^，,。；;【】]{1,20}签收/gu;
// Anything else that names a person or a phone: the wording stops before it.
const CONTACT = /签收人|收件人|联系人|(?:联系)?(?:电话|手机)(?:号码?)?[:：]?\s*\d|1[3-9]\d{9}|\d{3,4}-\d{7,8}/u;
// A row's later sentences are notices (the courier's vaccination, a call's length).
const SENTENCE_END = /[。！]/u;

/** A waybill on King Delivery's tracker, without spaces or hyphens. */
export function normalizeKingDeliveryNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'King Delivery waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * A row's wording: its first sentence, without the courier's name and phone or a
 * signatory. The rows are JD's domestic sentences under King Delivery's name.
 */
export function kingDeliveryRow(info: string): GinfoRowText {
  const text = info.replace(COURIER, (_match, bracket: string | undefined, role: string) => (bracket ? '' : role)).replace(SIGNATORY, '签收');
  const contact = CONTACT.exec(text);
  const kept = contact ? text.slice(0, contact.index) : text;
  const end = kept.search(SENTENCE_END);
  return { description: (end > 0 ? kept.slice(0, end) : kept).replace(/[\s，,；;：:（(]+$/u, '').trim() };
}

/** A row's place, unless `PLACE` holds the reason its wording gives in brackets ("因【…】"). */
export function kingDeliveryPlace(place: string, info: string): string {
  return info.includes(`因【${place}】`) ? '' : place;
}

/**
 * King Delivery's tenant of the GInfo server. Its page shows STATE 3 as
 * delivered (送达！) with ADATE as the delivery time. A record that hands the
 * parcel to JD names JD's express service in TRANSKIND and JD's waybill in
 * TRANS_NBR.
 */
export const KING_DELIVERY: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: KING_DELIVERY_API, site: KING_DELIVERY_SITE, normalize: normalizeKingDeliveryNumber,
  stage: kingDeliveryStage, statusMap, row: kingDeliveryRow, place: kingDeliveryPlace, deliveredState: true,
  transfers: { 京东快递: 'jd-logistics' },
};

/** The record King Delivery's tracker returns for one number. */
export const parseKingDelivery = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(KING_DELIVERY, body, raw, readAt);
