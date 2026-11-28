import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseGinfo, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { domesticWording } from '../valueway/parser.js';
import { huaxiaStage, statusMap } from './status.js';

export const PROVIDER = 'Huaxia Express';
export const CARRIER = 'huaxia-express';
/** Huaxia's tracking server, on its own site. */
export const HUAXIA_API = 'https://www.huaxiaglobal.ca/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const HUAXIA_SITE = 'https://www.huaxiaglobal.ca/track/';
// HE and ten digits, as the public sample.
const NUMBER = /^HE\d{10}$/;

const HOME = 'America/Vancouver';
const CHINA = 'Asia/Shanghai';
// The towns around Huaxia's Richmond office, as its rows write them.
const HOME_TOWNS = new Set(['richmond', 'vancouver', 'burnaby', '列治文', '温哥华']);
// A Chinese city, or several, as the domestic courier's rows give them: 哈尔滨市, 沈阳市/铁岭市/抚顺市.
const CHINESE_PLACE = /^\p{Script=Han}{1,10}[市县区州盟](?:\/\p{Script=Han}{1,10}[市县区州盟])*$/u;
// The flight leaving Vancouver for China, which the Canadian side writes.
const DEPARTURE = /^\s*航班起飞/u;
const HOME_NAMED = /温哥华|【\s*(?:YVR|Canada)\s*】/iu;
const CHINESE_CUSTOMS = /中国海关|口岸/u;
// A courier's name and phone in brackets, "【<name>，联系电话：<phone>】".
const CONTACT_BLOCK = /[[【][^\]】]*\d{5,}[^\]】]*[\]】]/gu;

/** A Huaxia waybill: HE and ten digits, without spaces or hyphens. */
export function normalizeHuaxiaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Huaxia Express waybills are HE and ten digits');
  return number;
}

/**
 * A row's wording. Huaxia's own rows are kept as written. The domestic courier's rows, which
 * the tracker copies after customs, lose the courier's name and phone, the signatory and the
 * notes after them; a facility cut short at its address keeps its closing bracket.
 */
export function huaxiaRow(info: string): GinfoRowText {
  const kept = domesticWording(info.replace(CONTACT_BLOCK, ''));
  const open = (kept.match(/【/gu) ?? []).length - (kept.match(/】/gu) ?? []).length;
  return { description: open > 0 ? `${kept}】` : kept };
}

/**
 * The clock a row is written on. A row placed in Richmond or Vancouver is on Vancouver's clock
 * and one placed in a Chinese city on China's. Huaxia's rows without a place name where they
 * were written: the airport and the flight leaving Vancouver are on Vancouver's clock, the
 * Chinese port and its customs on China's. A row that says neither keeps its wall clock.
 */
export function huaxiaZone(place: string, info: string): GinfoRowZone | null {
  const written = place.trim();
  if (HOME_TOWNS.has(written.toLowerCase())) return { zone: HOME, basis: 'place' };
  if (CHINESE_PLACE.test(written)) return { zone: CHINA, basis: 'place' };
  if (DEPARTURE.test(info)) return { zone: HOME, basis: 'carrier' };
  if (HOME_NAMED.test(info)) return { zone: HOME, basis: 'place' };
  if (CHINESE_CUSTOMS.test(info)) return { zone: CHINA, basis: 'place' };
  return null;
}

/**
 * Huaxia Express's tenant of the GInfo server. Its page shows STATE 3 as
 * delivered (送达！) with ADATE as the delivery time. A record handed to SF
 * Express names SF's interface in TRANSKIND and SF's waybill in TRANS_NBR.
 * Its rows mix Vancouver's and China's clocks, so each row is dated on its own.
 */
export const HUAXIA: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: HUAXIA_API, site: HUAXIA_SITE, normalize: normalizeHuaxiaNumber,
  stage: huaxiaStage, statusMap, row: huaxiaRow, zone: huaxiaZone, deliveredState: true,
  transfers: { 丰桥接口: 'sf-express' },
};

/** The record Huaxia's tracker returns for one number. */
export const parseHuaxia = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(HUAXIA, body, raw, readAt);
