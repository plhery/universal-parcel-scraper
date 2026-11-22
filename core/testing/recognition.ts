import { recognitionCandidates, type RecognitionOptions } from '../catalog/recognition.js';

/**
 * Whether recognition offers the carrier for the number as a last resort: flagged, and after every candidate that
 * is not. `outsideCountry` asks that it is one for being outside its countries.
 */
export function askedLast(number: string, carrier: string, options: RecognitionOptions = {}, reason?: 'outsideCountry'): boolean {
  const candidates = recognitionCandidates(number, options);
  const first = candidates.findIndex((candidate) => candidate.lastResort);
  return candidates.some((candidate) => candidate.carrier === carrier && candidate.lastResort === true
    && (reason === undefined || candidate[reason] === true))
    && candidates.slice(first).every((candidate) => candidate.lastResort === true);
}

/**
 * Whether recognition offers the carrier for the number as one outside the country: flagged, and after every
 * candidate that is not a last resort.
 */
export function outsideCountryLast(number: string, carrier: string, options: RecognitionOptions = {}): boolean {
  return askedLast(number, carrier, options, 'outsideCountry');
}
