import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { usStateTimeZone } from '../../core/time/index.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { qinhangStage, statusMap } from './status.js';

export const PROVIDER = 'Qinhang Transportation';
export const CARRIER = 'qinhang-transportation';
/** Qinhang's tracking server, where its site's form posts. */
export const QINHANG_API = 'http://www.qinhang56.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const QINHANG_SITE = 'http://www.qinhang56.com/';
// Letters and digits, with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const HOME = 'Asia/Shanghai';
// Where a row's contact details start: the trucking firm's phone after its tracking link, or a phone alone.
const CONTACT = /\s*(?:\b(?:card|truck)\s+company\s+)?\b(?:tele)?phone\b|\s*\bplease call\b|\s*(?:联系)?电话|\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]\d{4}\b|\b1[3-9]\d{9}\b/iu;
// A town and a US state's code, as "SAVANNAH, GA" or "Los Angeles, CA, US".
const US_PLACE = /^[A-Za-z][A-Za-z .'-]{1,40},\s*([A-Z]{2})(?:\s*,\s*(?:US|USA))?$/;
// States whose towns keep more than one clock: the state alone does not settle a row's.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
// ArcBest's tracking site, and the nine-digit PRO number a row gives with it.
const ARCBEST = /\barcb\.com\b/i;
const PRO = /\btracking number\s*[:：]\s*(\d{3}[ -]?\d{3}[ -]?\d{3})(?![ -]?\d)/i;

/** A waybill on Qinhang's tracker, without spaces or hyphens. */
export function normalizeQinhangNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Qinhang Transportation waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * A row's wording, without the contact details an operator's note can end with: the row that
 * names the US trucking firm gives its number and tracking site, then its phone.
 */
export function qinhangRow(info: string): GinfoRowText {
  const at = info.search(CONTACT);
  return { description: (at >= 0 ? info.slice(0, at) : info).replace(/[\s,，:：;；]+$/u, '') };
}

/**
 * The clock a row is written on. Qinhang's office writes every row, with Shenzhen as its place or
 * none, also once the container is in the United States, so a row is on China's clock unless its
 * place is a US town in a state of one clock.
 */
export function qinhangZone(place: string): GinfoRowZone | null {
  const state = US_PLACE.exec(place.trim())?.[1];
  if (!state) return { zone: HOME, basis: 'carrier' };
  const zone = SPLIT_STATES.has(state) ? null : usStateTimeZone(state);
  return zone ? { zone, basis: 'place' } : null;
}

/**
 * ABF Freight, ArcBest's LTL carrier, and its PRO number, when the newest row that names
 * ArcBest's tracking site gives one: Qinhang's note once the container is unpacked in the US.
 */
export function qinhangHandoff(result: CarrierResult, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const event of result.events ?? []) {
    const text = event.description ?? '';
    if (!ARCBEST.test(text)) continue;
    const pro = PRO.exec(text)?.[1]?.replace(/\D/g, '');
    return pro && pro !== number ? { delivery_carrier: 'abf-freight', delivery_tracking_number: pro } : {};
  }
  return {};
}

/**
 * Qinhang's tenant of the GInfo server, which answers in GBK. Its rows are
 * dated on China's clock, the clock of the office that writes them.
 */
export const QINHANG: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: QINHANG_API, site: QINHANG_SITE, normalize: normalizeQinhangNumber,
  stage: qinhangStage, statusMap, row: qinhangRow, zone: qinhangZone, encoding: 'gb18030',
};

/** The record Qinhang's tracker returns for one number, with ArcBest's hand-off when a row names it. */
export function withHandoff(result: CarrierResult, raw: string): CarrierResult {
  return { ...result, ...qinhangHandoff(result, normalizeQinhangNumber(raw)) };
}

/** The record Qinhang's tracker returns for one number, decoded. */
export const parseQinhang = (body: string, raw: string, readAt?: number): CarrierResult => withHandoff(parseGinfo(QINHANG, body, raw, readAt), raw);
