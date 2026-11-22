import { recognitionCandidates, type RecognitionOptions } from '../catalog/recognition.js';

/**
 * Whether recognition offers the carrier for the number as one outside the country: flagged, and after every
 * candidate that is not.
 */
export function outsideCountryLast(number: string, carrier: string, options: RecognitionOptions = {}): boolean {
  const candidates = recognitionCandidates(number, options);
  const first = candidates.findIndex((candidate) => candidate.outsideCountry);
  return candidates.some((candidate) => candidate.carrier === carrier && candidate.outsideCountry === true)
    && candidates.slice(first).every((candidate) => candidate.outsideCountry === true);
}
