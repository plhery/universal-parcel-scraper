/**
 * The detection engine.
 *
 * What it is: matches a tracking number against every carrier's catalog
 * detection rules and their checksums. Exactly one high-confidence match
 * selects a carrier; zero or several keep the number as a low-confidence
 * suggestion and return the candidates.
 * What it is not: no network lookup, no provider I/O, no carrier ranking by
 * popularity — only the rules declared in the catalog decide. A `preferred`
 * rule only moves its carrier to the front of the suggestions.
 */
import type { CarrierId } from '../../generated/catalog.js';
import type { DetectionRule } from '../catalog/types.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { isValidColissimoParcelNumber } from './colissimo.js';
import { isValidCorreosSpainCheckLetter } from './correosSpain.js';
import { isValidDpdParcelNumber } from './dpd.js';
import { isCttExpressTrackingNumber } from './cttExpress.js';
import { isValidEvriParcelNumber } from './evri.js';
import { isValidGlsParcelNumber } from './gls.js';
import { isValidHermesParcelNumber } from './hermes.js';
import { isValidMondialRelayBarcode } from './mondialRelay.js';
import { normalizeTrackingNumber } from './normalize.js';
import {
  hasGs1CheckDigit,
  hasLuhnCheckDigit,
  hasMod7CheckDigit,
  isValidDhlExpressWaybill,
  isValidFedExTrackingNumber,
  isValidPocztaPolskaBarcode,
  isValidSscc,
  isValidTntConsignmentNumber,
  isValidUkrposhtaBarcode,
} from './numericChecksums.js';
import { isValidS10TrackingNumber } from './s10.js';
import { isValidSfExpressWaybill } from './sfExpress.js';
import { isValidOnTracTrackingNumber, isValidUpsTrackingNumber } from './ups.js';
import { isValidUspsPackageBarcode } from './usps.js';
import type { CarrierDetection } from './types.js';

const CHECKSUMS: Record<NonNullable<DetectionRule['checksum']>, (trackingNumber: string) => boolean> = {
  'mondial-relay': isValidMondialRelayBarcode,
  s10: isValidS10TrackingNumber,
  hermes: isValidHermesParcelNumber,
  gls: isValidGlsParcelNumber,
  'dhl-express': isValidDhlExpressWaybill,
  tnt: isValidTntConsignmentNumber,
  'poczta-polska': isValidPocztaPolskaBarcode,
  'correos-spain': isValidCorreosSpainCheckLetter,
  dpd: isValidDpdParcelNumber,
  usps: isValidUspsPackageBarcode,
  sscc: isValidSscc,
  ups: isValidUpsTrackingNumber,
  colissimo: isValidColissimoParcelNumber,
  ukrposhta: isValidUkrposhtaBarcode,
  evri: isValidEvriParcelNumber,
  mod7: hasMod7CheckDigit,
  gs1: hasGs1CheckDigit,
  ontrac: isValidOnTracTrackingNumber,
  luhn: hasLuhnCheckDigit,
  fedex: isValidFedExTrackingNumber,
  'sf-express': isValidSfExpressWaybill,
};

function checksumPasses(rule: DetectionRule, trackingNumber: string): boolean {
  return rule.checksum === undefined || CHECKSUMS[rule.checksum](trackingNumber);
}

/** Return only a high-confidence carrier; preserve ambiguous candidates for the UI. */
export function detectCarrierMatch(raw: string): CarrierDetection {
  const printed = raw.trim().toUpperCase();
  const trackingNumber = normalizeTrackingNumber(raw);
  if (!trackingNumber) {
    return { carrier: 'unknown', confidence: 'none', candidates: [], preferred: [] };
  }

  const matches: { carrier: CarrierId; confidence: 'high' | 'low'; preferred: boolean }[] = [];
  for (const [carrier, definition] of Object.entries(CARRIER_DEFINITIONS)) {
    if (carrier === 'ctt-express' && !isCttExpressTrackingNumber(trackingNumber)) continue;
    // A carrier's first matching rule decides its confidence and preference.
    const rule = definition.detectionRules.find((candidate) =>
      new RegExp(candidate.pattern).test(trackingNumber)
      && (!candidate.rawPattern || new RegExp(candidate.rawPattern).test(printed))
      && checksumPasses(candidate, trackingNumber));
    if (rule) matches.push({ carrier: carrier as CarrierId, confidence: rule.confidence, preferred: rule.preferred === true });
  }

  const highConfidence = matches.filter((match) => match.confidence === 'high');
  const ranked = highConfidence.length > 0 ? highConfidence : matches;
  // Number evidence first; catalog order otherwise.
  const preferred = ranked.filter((match) => match.preferred).map((match) => match.carrier);
  const candidates = [...preferred, ...ranked.filter((match) => !match.preferred).map((match) => match.carrier)];
  if (highConfidence.length === 1) {
    return { carrier: highConfidence[0]!.carrier, confidence: 'high', candidates, preferred };
  }
  return {
    carrier: 'unknown',
    confidence: matches.length > 0 ? 'low' : 'none',
    candidates,
    preferred,
  };
}

/** Guess only when the tracking-number shape identifies one carrier confidently. */
export function detectCarrier(raw: string): CarrierId {
  return detectCarrierMatch(raw).carrier;
}
