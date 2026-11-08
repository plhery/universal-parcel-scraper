import { detectCarrierMatch } from '../detection/index.js';

export { followsPartnerNumbers } from './origins.js';

/**
 * Carriers whose tracker also finds a parcel by the number its delivery
 * partner gave it. Evri International answers Paack's, Hermes Germany's or
 * DHL's number with its own history of the parcel, and Sengi Express Poste
 * Italiane's code for a parcel it carries to Italy. That number is still the
 * partner's, unlike an origin's above.
 */
const PARTNER_NUMBER_TRACKERS: ReadonlySet<string> = new Set(['evri', 'sengi-express']);

/** Whether the carrier's tracker also finds parcels by their delivery partner's number. */
export function tracksPartnerNumbers(carrier: string): boolean {
  return PARTNER_NUMBER_TRACKERS.has(carrier);
}

/**
 * The partner that owns a number reported under one of those trackers: the
 * carrier another catalog rule claims the number for at high confidence.
 */
export function partnerNumberOwner(carrier: string, number: string): string | undefined {
  if (!PARTNER_NUMBER_TRACKERS.has(carrier)) return undefined;
  const detected = detectCarrierMatch(number);
  return detected.confidence === 'high' && detected.carrier !== carrier ? detected.carrier : undefined;
}
