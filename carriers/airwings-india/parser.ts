import type { CarrierResult } from '../../core/result/index.js';
import { airwingsStage } from './status.js';
import { parseXpresion, xpresionNumber, type XpresionTenant } from './xpresion.js';

/** Airwings India's Xpresion service, which the tracking page on airwingsindia.com asks. */
export const AIRWINGS_INDIA: XpresionTenant = {
  carrier: 'airwings-india', name: 'Airwings India', endpoint: 'https://xpresion.airwingsindia.com/api/v1/Tracking/Tracking',
  origin: 'https://airwingsindia.com', page: (number) => `https://airwingsindia.com/tracking.html?awbno=${encodeURIComponent(number)}`,
  // The login the tracking page sends for every visitor, written in the page itself.
  visitor: { UserID: 'CARD', Password: 'CARD@71' }, // gitleaks:allow
  // The page's "Forwarding No.", which opens the forwarding carrier's link with that number.
  forwarding: { number: 'VendorAWBNo1', link: 'VendorLinkURL', name: 'VendorName' },
  stage: airwingsStage,
};

export const normalizeAirwingsNumber = (raw: string): string => xpresionNumber(AIRWINGS_INDIA, raw);
export const parseAirwings = (body: string, raw: string, httpStatus = 200): CarrierResult => parseXpresion(AIRWINGS_INDIA, body, raw, httpStatus);
