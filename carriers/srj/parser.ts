import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { GINFO_MAX_BYTES, parseGinfo, type GinfoRowText, type GinfoTenant } from '../hgd/ginfo.js';
import { srjStage, statusMap } from './status.js';

export const PROVIDER = 'SRJ';
export const CARRIER = 'srj';
export const SRJ_MAX_BYTES = GINFO_MAX_BYTES;
/** SRJ's tracking server, where its site's form posts. */
export const SRJ_API = 'http://huayu-ex.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const SRJ_SITE = 'http://huayu-ex.com/';
// Letters and digits, with a digit: the tracker takes the numbers of every line it forwards on.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// A row SRJ's line relays ends in the line's code in brackets.
const CODED = /^([\s\S]*?)\s*\[([A-Z]{2})\]$/;
// The line joins a row's parts with bare commas; a place joins its own with a comma and a space.
const PART = /,(?=\S)/;
// A country code, or a place and its country, as USPS's "MC NABB, IL, US".
const PLACE = /^(?:[A-Z]{2}|[A-Z][A-Z .'-]*(?:, [A-Z]{2})+)$/;
// USPS's sentence after its status ("Delivered, In/At Mailbox -> Your item was delivered … in TOWN, ST 00000."),
// which repeats the scan's clock and place and names the recipient's ZIP code.
const SENTENCE = /\s+->\s[\s\S]*$/;

/** A waybill on SRJ's tracker, without spaces or hyphens. */
export function normalizeSrjNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SRJ waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * A row's wording, place and code. A row SRJ's line relays ends in the line's
 * code, and USPS's scans come as the line's status, the place and USPS's
 * wording: the place and the wording are kept, the status the code already
 * gives is not.
 */
export function srjRow(info: string): GinfoRowText {
  const coded = CODED.exec(info);
  if (!coded) return { description: info };
  const [, text, code] = coded as unknown as [string, string, string];
  const parts = text.split(PART);
  const [location, wording] = parts.length === 3 && PLACE.test(parts[1]!) ? [parts[1]!, parts[2]!]
    : parts.length === 2 && PLACE.test(parts[0]!) ? [parts[0]!, parts[1]!] : ['', text];
  return { description: wording.replace(SENTENCE, ''), location, code };
}

/**
 * SRJ's tenant of the GInfo server. Its page shows STATE 3 as delivered, at
 * the clock of USPS's delivery scan.
 */
export const SRJ: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: SRJ_API, site: SRJ_SITE, normalize: normalizeSrjNumber, stage: srjStage, statusMap,
  row: srjRow, deliveredState: true,
};

/** The record SRJ's tracker returns for one number. */
export const parseSrj = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(SRJ, body, raw, readAt);
