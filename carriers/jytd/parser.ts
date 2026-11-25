import type { CarrierResult } from '../../core/result/index.js';
import { airportTimeZone } from '../../places/index.js';
import { countryZones } from '../../places/zones.js';
import { parseHualeiPage, parseHualeiTrack, type HualeiRow, type HualeiTenant } from '../gzyl/hualei.js';
import { isJytdNotice, jytdStage } from './status.js';

export const PROVIDER = 'Jieyi Tongda';
export const JYTD_ORIGIN = 'http://123.207.50.250:8082';

// Israel Post's rows end their place with a unit's code or a flight's in brackets, often empty:
// "Savyon()", "Modiin eCommerce Sorting Center(5590)", "eCommerce System(5C-852)".
const UNIT = /\([^()]*\)$/;
// Israel Post's eCommerce System writes its manifest and customs rows, and is no place.
const SYSTEM = /^ecommerce system$/i;
const HOME_ZONES = new Set([...countryZones('CN'), ...countryZones('HK')]);

/**
 * A row's wording and place. The interface replies in GBK, which cannot hold Hebrew: a row Israel
 * Post words in Hebrew arrives as question marks alone and goes. Israel Post's places lose the code
 * in brackets after them, and its eCommerce System is no place.
 */
export function splitJytdRow(content: string, location: string): { content: string; location: string } {
  if (content.includes('?') && !/[\p{L}\p{N}]/u.test(content)) return { content: '', location: '' };
  const place = location.trim().replace(UNIT, '').trim();
  return { content, location: SYSTEM.test(place) ? '' : place };
}

/** A place in mainland China or Hong Kong: its country's code, or an airport there named by its code alone ("HKG"). */
function home(place: string): boolean {
  if (place === 'CN' || place === 'HK') return true;
  const zone = /^[A-Z]{3}$/.test(place) ? airportTimeZone(place) : null;
  return zone !== null && HOME_ZONES.has(zone);
}

/**
 * The warehouse's rows, which carry a kind code, the order's rows, placed nowhere, and the export
 * and departure rows at China's and Hong Kong's places are on the platform's Beijing clock, which is
 * Hong Kong's too. A row placed abroad, as Israel Post's copies and the landing at Tel Aviv, keeps
 * its wall clock: on Beijing's clock the postman units would receive the parcel before dawn in Israel.
 */
export function jytdClock(row: HualeiRow): 'platform' | 'wall' {
  const place = row.location.trim();
  return row.code || !place || home(place) ? 'platform' : 'wall';
}

/**
 * Jieyi Tongda's (捷易通达, JYTD) tenant of the Hualei platform. Its line to Israel copies Israel
 * Post's scans into the record under the forwarder's own waybill, which the record's tracking
 * number holds; the record names no other number.
 */
export const JYTD: HualeiTenant = {
  carrier: 'jytd', provider: PROVIDER, origin: JYTD_ORIGIN, stage: jytdStage, split: splitJytdRow, clock: jytdClock,
  notice: (_code, wording) => isJytdNotice(wording),
};

/** The track interface's reply, or null when it holds no row for the number. */
export const parseJytdTrack = (payload: unknown, number: string, readAt?: number): CarrierResult | null =>
  parseHualeiTrack(payload, number, JYTD, readAt);
export const parseJytdPage = (html: string, number: string, readAt?: number): CarrierResult =>
  parseHualeiPage(html, number, JYTD, readAt);
