/**
 * Candidate numbers inside free text.
 *
 * What it is: the shapes worth testing when a whole shipping message, or a URL
 * with no matching link rule, is pasted, and the two scans over them.
 * What it is not: no carrier decision of its own (it defers to the detection
 * engine) and no provider I/O.
 */
import { AMAZON_NUMBER_PATTERN } from './amazon.js';
import { detectCarrierMatch } from './detect.js';
import { validTrackingNumber } from './normalize.js';

export const TRACKING_CANDIDATE_PATTERNS = [
  new RegExp(`\\b${AMAZON_NUMBER_PATTERN.slice(1, -1).replaceAll('[0-9]', '(?:[\\s.-]*[0-9])')}\\b`, 'gi'),
  // NACEX agency/shipment composites keep their slash boundary (never stripped).
  /\b\d{4}\/\d{8}\b/g,
  /\b\d{26}\b/g,
  /\bH\d{15,19}\b/gi,
  /\b1Z[A-Z0-9]{16}\b/gi,
  /\b1G[A-Z0-9]{10}\b/gi,
  /\b[A-Z]{2}\s*\d(?:[\s.-]?\d){8}\s*[A-Z]{2}\b/gi,
  /\b(?:JJD|JVGL)[A-Z0-9]{8,}\b/gi,
  /\b\d(?:[\s.-]?\d){9,19}\b/g,
  // Let catalog rules claim other complete identifiers without copying their shapes here.
  /\b[A-Z0-9]{4,40}\b/gi,
];

/** The first candidate in the text that one carrier claims confidently. */
export function recognizedNumberInText(raw: string): string | undefined {
  for (const pattern of TRACKING_CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const candidate = match[0].trim();
      if (detectCarrierMatch(candidate).confidence === 'high') return candidate;
    }
  }
  return undefined;
}

// The second word of a label. "No" and "ID" also start numbers, so they belong
// to the label only when they stand apart from what follows.
const LABEL_SUFFIX = String.raw`(?:numbers?(?![A-Z])|no\.|(?:no|id)(?![A-Z0-9.]))`;
const LABELLED_NUMBER = new RegExp(
  String.raw`(?:track(?:ing)?(?:\s*${LABEL_SUFFIX}|(?![A-Z]))`
  + String.raw`|(?:parcel|shipment)(?:\s+(?:tracking(?![A-Z])|${LABEL_SUFFIX})|(?![A-Z])))`
  + String.raw`(?:\s+is(?![A-Z0-9]))?\s*[:#-]?\s*`
  // The token holds a digit, so a label followed by a plain word does not end the search.
  + String.raw`((?=[A-Z0-9.-]{0,39}\d)[A-Z0-9][A-Z0-9.-]{3,39})`,
  'i',
);

/** Last resort: a number introduced by a "tracking number:" style label. */
export function keywordNumberInText(raw: string): string | undefined {
  // A sentence can end right after its number.
  const candidate = LABELLED_NUMBER.exec(raw)?.[1]?.replace(/[.-]+$/, '');
  return candidate && validTrackingNumber(candidate) ? candidate : undefined;
}
