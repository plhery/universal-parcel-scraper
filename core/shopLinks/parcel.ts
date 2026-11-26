import type { CarrierId } from '../../generated/catalog.js';
import { detectCarrierMatch } from '../detection/detect.js';
import { validTrackingNumber } from '../detection/valid.js';
import type { ShopLinkParcel } from './types.js';

/**
 * The parcel a number and the courier a shop's page names make. The named courier stands unless the number's own
 * shape is surely another carrier's, as a retailer may file a USPS-delivered number under the carrier it booked.
 * Without one, the number's shape names the carrier.
 */
export function linkParcel(number: string, named?: CarrierId, courierCode?: string): ShopLinkParcel | undefined {
  const trackingNumber = number.trim();
  if (!validTrackingNumber(trackingNumber) || !/\d/.test(trackingNumber)) return undefined;
  const code = courierCode ? { courierCode } : {};
  const detected = detectCarrierMatch(trackingNumber);
  if (named && (detected.confidence !== 'high' || detected.candidates.includes(named))) {
    return { trackingNumber, carrier: named, confidence: 'high', ...code };
  }
  return { trackingNumber, carrier: detected.carrier, confidence: detected.confidence, ...code };
}
