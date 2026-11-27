import type { CarrierId } from '../../generated/catalog.js';
import { detectCarrierMatch } from '../detection/detect.js';
import { linkRulesForHost, numberFromRule, parseTrackingInput } from '../detection/parse.js';
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

/**
 * The parcel a carrier's tracking link names by the catalog's link rules, as the paste parser reads it. Any other
 * address names none, even one holding a number.
 */
export function carrierLinkParcel(url: URL): ShopLinkParcel | undefined {
  const ruled = linkRulesForHost(url.hostname.toLowerCase())
    .some((rule) => (!rule.pathPattern || rule.pathPattern.test(url.pathname)) && numberFromRule(url, rule));
  if (!ruled) return undefined;
  const match = parseTrackingInput(url.href);
  if (match.source !== 'link' || !match.trackingNumber) return undefined;
  return { trackingNumber: match.trackingNumber, carrier: match.carrier, confidence: match.confidence };
}
