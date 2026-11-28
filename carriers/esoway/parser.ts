import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isZtoTrackingNumber } from '../../core/detection/zto.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { parseGinfo, type GinfoOnward, type GinfoRowText, type GinfoRowZone, type GinfoTenant } from '../hgd/ginfo.js';
import { relayedZtoText } from '../zto/relayed.js';
import { esowayStage, statusMap } from './status.js';

export const PROVIDER = 'ESOWAY';
export const CARRIER = 'esoway';
/** ESOWAY's tracking server, where its site's form posts. */
export const ESOWAY_API = 'http://www.esoway.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const ESOWAY_SITE = 'http://www.esoway.com/';
// Letters and digits, with a digit, as the site's form takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const HOME = 'America/Vancouver';
const CHINA = 'Asia/Shanghai';
// The row whose place labels its text as ZTO's waybill.
const TRANSFER_PLACE = /^中通(?:快递)?转单号$/u;
const TRANSFER_ROW = /^中通(?:快递)?转单号[:：]\s*([A-Z0-9]{8,30})$/u;
// A pickup locker or point, whose name can give the recipient's building.
const PICKUP_POINT = /驿站|丰巢|快递柜|智能柜|代收点|自提|超市|柜/u;
const VANCOUVER = /温哥华|列治文|本拿比|加拿大|\b(?:Vancouver|Richmond|Burnaby)\b/iu;
// ESOWAY's own rows: the flight leaving Canada, the parcel reaching China, its clearance there.
const DEPARTING = /飞往中国|发往中国|起飞/u;
const ARRIVED = /(?:抵达|到达)中国|中国处理中心/u;
const CUSTOMS = /海关|清关/u;

/** A waybill on ESOWAY's tracker, without spaces or hyphens. */
export function normalizeEsowayNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ESOWAY waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * A row's wording and the city it names. The row whose place reads 中通转单号 gives ZTO's waybill
 * as its text; ZTO's sentences, which ESOWAY copies once ZTO has the parcel, name the city in
 * brackets, the courier with a mobile, the branch's and complaint lines and the pickup locker,
 * all left out but the city.
 */
export function esowayRow(info: string, place: string): GinfoRowText {
  if (TRANSFER_PLACE.test(place)) return { description: `${place}：${info}` };
  const { description, city } = relayedZtoText(info);
  return { description, ...(city ? { location: city } : {}) };
}

/** A row's place, or '' for the waybill label and for a pickup locker, whose name can give the recipient's building. */
export function esowayPlace(place: string): string {
  return TRANSFER_PLACE.test(place) || PICKUP_POINT.test(place) ? '' : place;
}

/**
 * The clock a row is written on. ESOWAY's Vancouver office writes its rows until the flight
 * leaves, on Pacific time; its rows from the parcel's arrival in China, the waybill row and
 * ZTO's, which name a ZTO site, are on China's clock. A row that says neither keeps its wall clock.
 */
export function esowayZone(place: string, info: string): GinfoRowZone | null {
  if (VANCOUVER.test(place)) return { zone: HOME, basis: 'place' };
  if (TRANSFER_PLACE.test(place)) return { zone: CHINA, basis: 'destination' };
  if (place || ARRIVED.test(info)) return { zone: CHINA, basis: 'place' };
  if (CUSTOMS.test(info)) return { zone: CHINA, basis: 'destination' };
  if (VANCOUVER.test(info)) return { zone: HOME, basis: 'place' };
  if (DEPARTING.test(info)) return { zone: HOME, basis: 'carrier' };
  return null;
}

/**
 * ZTO and its waybill, when one waybill row names a number ZTO's rules take and `REFER_NBR`,
 * which repeats it, does not give another. ZTO's 14-digit waybills are a shape other carriers
 * share, so the shared reader's high-confidence check would not name ZTO.
 */
export function esowayOnward(reference: string, events: readonly CarrierEvent[], number: string): GinfoOnward {
  const named = new Set(events.flatMap((event) => {
    const match = TRANSFER_ROW.exec(event.description ?? '');
    return match ? [match[1]!] : [];
  }));
  if (named.size !== 1) return {};
  const [waybill] = [...named] as [string];
  const repeated = normalizeTrackingNumber(reference);
  return (!repeated || repeated === waybill) && waybill !== number && isZtoTrackingNumber(waybill)
    ? { delivery_carrier: 'zto', delivery_tracking_number: waybill } : {};
}

/**
 * ESOWAY's tenant of the GInfo server, which answers in GBK. Its page shows
 * STATE 3 as delivered (送达！) with ADATE as the delivery time.
 */
export const ESOWAY: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: ESOWAY_API, site: ESOWAY_SITE, normalize: normalizeEsowayNumber,
  stage: esowayStage, statusMap, row: esowayRow, place: esowayPlace, zone: esowayZone, onward: esowayOnward,
  deliveredState: true, encoding: 'gb18030',
};

/** The record ESOWAY's tracker returns for one number, decoded. */
export const parseEsoway = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(ESOWAY, body, raw, readAt);
