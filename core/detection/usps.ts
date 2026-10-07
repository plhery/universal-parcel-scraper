import { normalizeTrackingNumber } from './normalize.js';

// USPS Publication 199, sections 4.1–4.6: the routing AI and ZIP precede
// the PIC, and only the PIC participates in its alternating MOD10 check.
// https://postalpro.usps.com/pub199
function validPic(number: string): boolean {
  if (!/^9[234]\d{20}(?:\d{4})?$/.test(number)) return false;
  let sum = 0;
  for (let i = number.length - 1; i >= 0; i--) {
    sum += Number(number[i]) * ((number.length - 1 - i) % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** A whole IMpb, with an optional five- or nine-digit routing ZIP. */
export function uspsPackageIdentifier(raw: string): string | null {
  const number = normalizeTrackingNumber(raw);
  if (validPic(number)) return number;
  if (!/^420\d{27}(?:\d{4})?$/.test(number)) return null;
  const matches = [number.slice(8), number.slice(12)].filter(validPic);
  // A 34-digit scan could contain a ZIP5/PIC26 or ZIP9/PIC22. Never guess.
  return matches.length === 1 ? matches[0]! : null;
}

export function isValidUspsPackageBarcode(raw: string): boolean {
  return uspsPackageIdentifier(raw) !== null;
}
