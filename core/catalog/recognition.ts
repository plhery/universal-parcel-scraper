/**
 * Which carriers recognition asks about an ambiguous number.
 *
 * What it is: the ranked candidates whose adapter can cheaply say whether it
 * knows a number. The detect route and routing ask them; the Add sheets name
 * them while the answer is on its way.
 * What it is not: no provider I/O. Asking the carriers is the server's job
 * (`src/server/carrierRecognition.ts`).
 */
import { CARRIER_RECOGNITION_RANKS } from '../../generated/recognition.js';
import { detectCarrierMatch } from '../detection/detect.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { AUTOMATIC_CARRIER_IDS, CARRIER_DEFINITIONS, carrierAdapter, requiredRequirements } from './definitions.js';
import { carrierBrand } from './networks.js';
import type { CarrierInputField } from './types.js';

/** Carriers asked at once. */
export const MAX_RECOGNITIONS = 5;

export interface RecognitionCandidate {
  carrier: string;
  /** The first input the carrier needs before it can track, if any. */
  needsInput: CarrierInputField | null;
  /** A preferred detection rule backs it with number evidence. */
  preferred: boolean;
}

/**
 * The low-confidence candidates worth asking, best first: the carrier a
 * universal provider named, then the ones number evidence backs, then the
 * catalog's popularity rank. HTTP is the default; `phase: 'browser'` selects
 * the separate opt-in browser catalog. A high-confidence dedicated carrier needs no recognition; the
 * unknown postal carrier still needs a direct carrier to confirm it.
 */
export function recognitionCandidates(
  number: string,
  options: { hint?: string; skip?: (carrier: string) => boolean; phase?: 'http' | 'browser' } = {},
): RecognitionCandidate[] {
  const detected = detectCarrierMatch(number);
  const unknownPostalCarrier = detected.carrier === 'intl-post';
  if (detected.confidence !== 'low' && !unknownPostalCarrier) return [];
  // The high-confidence S10 fallback hides low-confidence carrier rules from
  // detection. Recover those candidates without assigning the issuer's
  // postal carrier as the deliverer: each candidate must confirm this number.
  // intl-post already checked the S10 checksum, so only S10 or shape-only rules
  // can contribute here.
  const normalized = normalizeTrackingNumber(number);
  const postalMatches = unknownPostalCarrier ? Object.entries(CARRIER_DEFINITIONS)
    .flatMap(([carrier, definition]) => {
      const rule = definition.detectionRules.find((candidate) => candidate.confidence === 'low'
        && (!candidate.checksum || candidate.checksum === 's10')
        && new RegExp(candidate.pattern).test(normalized)
        && (!candidate.rawPattern || new RegExp(candidate.rawPattern).test(number.trim().toUpperCase())));
      return rule ? [{ carrier, preferred: rule.preferred === true }] : [];
    }) : [];
  const candidates: readonly string[] = unknownPostalCarrier ? postalMatches.map(({ carrier }) => carrier) : detected.candidates;
  const preferred: readonly string[] = unknownPostalCarrier
    ? postalMatches.filter((match) => match.preferred).map(({ carrier }) => carrier) : detected.preferred;
  const ranks: Readonly<Record<string, number | undefined>> = options.phase === 'browser'
    ? Object.fromEntries(Object.entries(CARRIER_DEFINITIONS).map(([id, definition]) => [id, definition.tracking.browserRecognitionRank]))
    : CARRIER_RECOGNITION_RANKS;
  // A carrier the number points to but that cannot be asked (DPD France) keeps
  // its brand's other networks out: DPD's guest API also answers for DPD
  // France parcels, and would file one under DPD Switzerland.
  const shadowed = new Set(preferred
    .filter((carrier) => ranks[carrier] === undefined)
    .map((carrier) => carrierBrand(carrier)).filter(Boolean));
  const score = (carrier: string) => [
    carrier === options.hint ? 1 : 0,
    preferred.includes(carrier) ? 1 : 0,
    ranks[carrier] ?? 0,
  ];
  return candidates
    .filter((carrier) => ranks[carrier] !== undefined && AUTOMATIC_CARRIER_IDS.has(carrier)
      && carrierAdapter(carrier) !== 'universal' && !shadowed.has(carrierBrand(carrier)) && !options.skip?.(carrier))
    .map((carrier) => ({ carrier, score: score(carrier) }))
    // Array#sort is stable: equal scores keep the catalog order.
    .sort((left, right) => right.score[0]! - left.score[0]! || right.score[1]! - left.score[1]! || right.score[2]! - left.score[2]!)
    .map(({ carrier }) => ({
      carrier,
      needsInput: requiredRequirements(carrier, number)[0]?.field ?? null,
      preferred: preferred.includes(carrier),
    })).filter((candidate) => options.phase !== 'browser' || !candidate.needsInput);
}

/** The carriers the detect route asks about a number, best first; empty when none can answer. */
export function recognitionAskedCarriers(number: string): string[] {
  return recognitionCandidates(number).slice(0, MAX_RECOGNITIONS).map(({ carrier }) => carrier);
}
