import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { countryTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { statusMap, yhtStage } from './status.js';

export const PROVIDER = 'Shanghai Aerospace Logistics';
export const CARRIER = 'yhtlogistics';
/** Shanghai Aerospace Logistics' tracking server, which its site's tracking form asks. */
export const YHT_API = 'http://www.yhtlogistics.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const YHT_SITE = 'http://www.yhtlogistics.com/';
// Letters and digits, with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const CHINA = 'Asia/Shanghai';
// The firm's own rows name its office in Chinese.
const OFFICE = /^(?:上海|深圳|广州|北京)$/u;
// DHL's place, "<town> - <country>", the country sometimes followed by a comma and the rest of its name
// ("CHINA, PEOPLES REPUBLIC").
const TOWN_COUNTRY = /^.+?\s-\s([^,]+?)(?:,.*)?$/u;
// DHL's delivery row ends with who signed: "已派送-签收人: <name>".
const SIGNER = /\s*-?\s*签收人\s*[:：][\s\S]*$/u;

/** A waybill on Shanghai Aerospace Logistics' tracker, without spaces or hyphens. */
export function normalizeYhtNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shanghai Aerospace Logistics waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * A row's wording. DHL's rows, which the tracker relays, repeat their place after the wording on some
 * scans and not on others, and its delivery names who signed: the place repeated is left out, so the
 * two forms of one scan read once, and the delivery keeps its wording without the signer.
 */
export function yhtRow(info: string, place: string): GinfoRowText {
  const unsigned = SIGNER.test(info) ? info.replace(SIGNER, '') || '已签收' : info;
  const text = place && unsigned.endsWith(` ${place}`) ? unsigned.slice(0, -place.length - 1) : unsigned;
  return { description: clean(text, 300) };
}

/**
 * The clock a row is written on: the firm's office in China, or the country DHL names after a town when
 * that country has one clock (China, Singapore). A town alone, or a country with several clocks
 * (Australia), names no zone here and the row keeps its wall clock.
 */
export function yhtZone(place: string): GinfoRowZone | null {
  if (OFFICE.test(place)) return { zone: CHINA, basis: 'place' };
  const country = TOWN_COUNTRY.exec(place)?.[1];
  const zone = country ? countryTimeZone(country) : null;
  return zone ? { zone, basis: 'place' } : null;
}

/** Shanghai Aerospace Logistics' tenant of the GInfo server, which answers in GBK. */
export const YHT: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: YHT_API, site: YHT_SITE, normalize: normalizeYhtNumber,
  stage: yhtStage, statusMap, row: yhtRow, zone: yhtZone, transfers: { DHL: 'dhl-express' }, encoding: 'gb18030',
};

/** The record Shanghai Aerospace Logistics' tracker returns for one number, decoded. */
export const parseYht = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(YHT, body, raw, readAt);
