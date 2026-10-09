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
import type { CarrierId } from '../../generated/catalog.js';
import { CHECKSUMS } from '../detection/checksums.js';
import { detectCarrierMatch } from '../detection/detect.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { countryTimeZone } from '../time/index.js';
import { AUTOMATIC_CARRIER_IDS, CARRIER_DEFINITIONS, carrierAdapter, carrierTimezone, requiredRequirements } from './definitions.js';
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

export interface RecognitionOptions {
  hint?: string;
  skip?: (carrier: string) => boolean;
  phase?: 'http' | 'browser';
  /** A caller's country is a query-order hint, never carrier confirmation. */
  countryHint?: string | null;
  /** Caller-owned aggregate scores; larger finite, nonnegative values run first. */
  priorities?: Readonly<Record<string, number>>;
}

/** A coarse whole-number shape, with no identifier characters retained. */
export function recognitionNumberShape(number: string): string | undefined {
  const normalized = normalizeTrackingNumber(number);
  if (!/^[A-Z0-9]{4,40}$/.test(normalized)) return undefined;
  return normalized.match(/[A-Z]+|[0-9]+/g)!
    .map((run) => `${/^[0-9]/.test(run) ? 'D' : 'A'}${run.length}`).join('');
}

/** Whether the rule that offered a carrier for this number passed a check digit. */
function checked(carrier: string, normalized: string, printed: string): boolean {
  const rule = CARRIER_DEFINITIONS[carrier as CarrierId]?.detectionRules.find((candidate) =>
    new RegExp(candidate.pattern).test(normalized)
    && (!candidate.rawPattern || new RegExp(candidate.rawPattern).test(printed))
    && (!candidate.checksum || CHECKSUMS[candidate.checksum](normalized)));
  return rule?.checksum !== undefined;
}

interface RankedCandidate extends RecognitionCandidate {
  /** Something besides the catalog's rank placed it: a hint, number evidence, the country or a priority. */
  backed: boolean;
}

/**
 * The low-confidence candidates worth asking, best first: the carrier a
 * universal provider named, then the ones number evidence backs, then the
 * country hint, caller-owned priorities, a passing check digit and the
 * catalog's popularity rank. These hints only order existing candidates. HTTP is the default; `phase: 'browser'` selects
 * the separate opt-in browser catalog. A high-confidence dedicated carrier needs no recognition; the
 * unknown postal carrier still needs a direct carrier to confirm it.
 */
export function recognitionCandidates(
  number: string,
  options: RecognitionOptions = {},
): RecognitionCandidate[] {
  return rankedCandidates(number, options).map(({ carrier, needsInput, preferred }) => ({ carrier, needsInput, preferred }));
}

function rankedCandidates(number: string, options: RecognitionOptions): RankedCandidate[] {
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
  const country = options.countryHint?.trim().toUpperCase();
  const countryScore = (carrier: string) => {
    if (!country || !/^[A-Z]{2}$/.test(country)) return 0;
    const countries = CARRIER_DEFINITIONS[carrier as CarrierId]?.countries ?? [];
    return countries[0] === country ? 2 : countries.includes(country) ? 1 : 0;
  };
  const priorityScore = (carrier: string) => {
    const priority = options.priorities?.[carrier];
    return typeof priority === 'number' && Number.isFinite(priority) && priority >= 0 ? priority : 0;
  };
  const printed = number.trim().toUpperCase();
  const score = (carrier: string) => [
    carrier === options.hint ? 1 : 0,
    preferred.includes(carrier) ? 1 : 0,
    countryScore(carrier),
    priorityScore(carrier),
    checked(carrier, normalized, printed) ? 1 : 0,
    ranks[carrier] ?? 0,
  ];
  return candidates
    .filter((carrier) => ranks[carrier] !== undefined && AUTOMATIC_CARRIER_IDS.has(carrier)
      && carrierAdapter(carrier) !== 'universal' && !shadowed.has(carrierBrand(carrier)) && !options.skip?.(carrier))
    .map((carrier) => ({ carrier, score: score(carrier) }))
    // Array#sort is stable: equal scores keep the catalog order.
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index++) {
        const difference = right.score[index]! - left.score[index]!;
        if (difference) return difference;
      }
      return 0;
    })
    .map(({ carrier, score }) => ({
      carrier,
      needsInput: requiredRequirements(carrier, number)[0]?.field ?? null,
      preferred: preferred.includes(carrier),
      backed: score.slice(0, -1).some((value) => value > 0),
    })).filter((candidate) => options.phase !== 'browser' || !candidate.needsInput);
}

/** The continent of a carrier's home country, read from its clock; undefined where that says none. */
function continent(carrier: string): string | undefined {
  const zone = countryTimeZone(CARRIER_DEFINITIONS[carrier as CarrierId]?.countries?.[0]) ?? carrierTimezone(carrier);
  return zone.includes('/') ? zone.split('/')[0] : undefined;
}

/**
 * The carriers the detect route asks about a number, best first; empty when none can answer.
 * Without the caller's country, popularity alone can fill every place with one continent's
 * carriers. The last place then goes to the best-ranked carrier from another continent,
 * unless something besides rank put its holder there.
 */
export function recognitionAskedCarriers(number: string, options: RecognitionOptions = {}): string[] {
  const ranked = rankedCandidates(number, options);
  const asked = ranked.slice(0, MAX_RECOGNITIONS);
  const last = asked.at(-1);
  if (asked.length === MAX_RECOGNITIONS && !last!.backed && !options.countryHint?.trim()) {
    const served = new Set(asked.slice(0, -1).map(({ carrier }) => continent(carrier)));
    const other = ranked.slice(MAX_RECOGNITIONS).find(({ carrier }) => {
      const place = continent(carrier);
      return place !== undefined && !served.has(place);
    });
    if (other) asked[asked.length - 1] = other;
  }
  return asked.map(({ carrier }) => carrier);
}
