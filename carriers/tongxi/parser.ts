import { countryCode } from '../../core/time/index.js';
import { alpha3Country } from '../../places/alpha3.js';
import type { HualeiRow, HualeiTenant } from '../gzyl/hualei.js';
import { tongxiStage } from './status.js';

export const PROVIDER = 'TongXi';
export const TONGXI_ORIGIN = 'http://1.14.133.93:8082';

// The delivery carrier's rows the line relays: its step, then its sentence to the recipient,
// "Out for Delivery Your shipment is out for delivery".
const DELIVERY_ROW = /\bYour shipment\b/i;
// A country's three-letter code, which the line writes after its name ("Spain,ESP").
const ALPHA3 = /^[A-Z]{3}$/;
// A closing preposition whose place is left out, as "Departed from customs of" at "Spain,ESP".
const DANGLING = /\s+(?:of|to|in|at|from)$/i;

const namedCountry = (value: string): string | null => countryCode(value) ?? (ALPHA3.test(value) ? alpha3Country(value) : null);

/** Whether a row is one the line relays from the delivery carrier in the destination country. */
export const isTongxiDeliveryRow = (content: string): boolean => DELIVERY_ROW.test(content);

/**
 * The line's own rows name the destination country, by name and code, from the origin airport on
 * ("Arrived at airport of the original country" at "Spain,ESP"): a place that is only a country is
 * left out of them, and a closing preposition with it. The delivery carrier's rows keep theirs.
 */
export function splitTongxiRow(content: string, location: string): { content: string; location: string } {
  if (isTongxiDeliveryRow(content)) return { content, location };
  const parts = location.split(',').map((part) => part.trim());
  const country = namedCountry(parts[0]!);
  if (!country || !parts.every((part) => namedCountry(part) === country)) return { content, location };
  return { content: content.trim().replace(DANGLING, ''), location: '' };
}

/**
 * The line's rows, in China, at the airports and through customs, and its "Parcel in transit"
 * every two days, are on the platform's Beijing clock: on Madrid's, the arrival at the origin
 * airport, the first-mile departure and the customs departure would come before the platform
 * wrote them. The delivery carrier's rows keep their wall clock in the destination country: on
 * Beijing's, its courier would have gone out for delivery at 01:53 and failed at 04:40 in Spain.
 */
export const tongxiClock = (row: HualeiRow): 'platform' | 'wall' => (isTongxiDeliveryRow(row.content) ? 'wall' : 'platform');

/**
 * TongXi's (深圳市桐溪供应链管理有限公司) tenant of the Hualei platform. Its line into Europe ends
 * with a delivery carrier the record does not name, whose rows it copies under TongXi's number.
 */
export const TONGXI: HualeiTenant = {
  carrier: 'tongxi', provider: PROVIDER, origin: TONGXI_ORIGIN, stage: tongxiStage, split: splitTongxiRow, clock: tongxiClock,
};
