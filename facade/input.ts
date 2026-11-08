import type { ParcelInput } from './index.js';

/** The optional fields' types and shapes, checked before any lookup or recognition starts. */
export function checkParcelFields(input: ParcelInput): void {
  if (input.countryHint != null && typeof input.countryHint !== 'string') throw new TypeError('Invalid country hint');
  if (input.postcode != null && typeof input.postcode !== 'string') throw new TypeError('Invalid postcode');
  if (input.postcodeCountry != null && (typeof input.postcodeCountry !== 'string' || !/^\s*[A-Za-z]{2}\s*$/.test(input.postcodeCountry))) {
    throw new TypeError('Invalid postcode country');
  }
  if (input.trackingUrl != null && typeof input.trackingUrl !== 'string') throw new TypeError('Invalid tracking URL');
  if (input.phoneDigits != null && typeof input.phoneDigits !== 'string') throw new TypeError('Invalid phone digits');
  if (input.language != null && (typeof input.language !== 'string' || input.language.length > 35)) throw new TypeError('Invalid language');
}
