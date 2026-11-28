import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseGinfo, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { jdExpressUsaStage, statusMap } from './status.js';

export const PROVIDER = 'JD Express USA';
export const CARRIER = 'jdexpressusa';
/** JD Express USA's tracking server, where its site's form posts. */
export const JDEXPRESSUSA_API = 'http://www.jdexpressusa.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const JDEXPRESSUSA_SITE = 'http://www.jdexpressusa.com/';
// Letters and digits, with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const HOME = 'America/Los_Angeles';
const CHINA = 'Asia/Shanghai';
// The flight leaving the United States, which the US side writes.
const DEPARTING = /飞往中国|起飞/u;
const CHINA_PLACE = /中国/u;
// The firm's warehouses in Oregon and Los Angeles, and Los Angeles' airport.
const US_PLACE = /洛杉矶|俄勒冈|美国/u;
// The port of entry and customs, in China.
const CUSTOMS = /清关|海关|口岸/u;
const WAREHOUSE = /仓储|仓库/u;

/** A waybill on JD Express USA's tracker, without spaces or hyphens. */
export function normalizeJdExpressUsaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'JD Express USA waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * The clock a row is written on. The rows name no place, so their wording decides: the firm's
 * warehouse, Los Angeles' airport and the flight leaving for China are on Pacific time; the
 * parcel's arrival at a Chinese port and its clearance are on China's clock. A row that says
 * neither keeps its wall clock.
 */
export function jdExpressUsaZone(place: string, info: string): GinfoRowZone | null {
  const text = `${place} ${info}`;
  if (DEPARTING.test(text)) return { zone: HOME, basis: 'carrier' };
  if (CHINA_PLACE.test(text)) return { zone: CHINA, basis: 'place' };
  if (US_PLACE.test(text)) return { zone: HOME, basis: 'place' };
  if (CUSTOMS.test(text)) return { zone: CHINA, basis: 'destination' };
  if (WAREHOUSE.test(text)) return { zone: HOME, basis: 'carrier' };
  return null;
}

/** JD Express USA's tenant of the GInfo server, which answers in GBK. */
export const JDEXPRESSUSA: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: JDEXPRESSUSA_API, site: JDEXPRESSUSA_SITE, normalize: normalizeJdExpressUsaNumber,
  stage: jdExpressUsaStage, statusMap, zone: jdExpressUsaZone, encoding: 'gb18030',
};

/** The record JD Express USA's tracker returns for one number, decoded. */
export const parseJdExpressUsa = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(JDEXPRESSUSA, body, raw, readAt);
