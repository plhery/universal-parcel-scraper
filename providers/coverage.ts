/**
 * What each universal provider returned for public references of a carrier
 * ([coverage.json](coverage.json), rendered in COVERAGE.md), graded for routing.
 *
 * A carrier's references decide one tier per provider:
 * - `full`: history, with none marked partial and no reference missed that
 *   another provider knew;
 * - `partial`: history, but marked partial (label only, stops early, missing a
 *   leg, undated), or missing a reference another provider knew;
 * - `unknown`: nothing conclusive (errors, challenges, unverified, or only
 *   negatives on references too old to say anything);
 * - `empty`: answered without history the library can use (no history, summary
 *   only, scans without an instant, a sign-in or postcode prompt);
 * - `excluded`: never history, and it answered with another carrier's parcel
 *   or refused the number format; or, whatever it once returned, it now keeps
 *   the carrier for its subscribers (`subscriber_only`).
 *
 * Positives are strong evidence, negatives weak: one old reference can miss a
 * parcel the provider would know today. So an empty provider is asked last,
 * never skipped; only a wrong parcel, a refused format or a courier kept for
 * subscribers excludes it.
 *
 * A consumer that counts its own lookups (`ObservedCoverage`) has stronger
 * evidence than a few references, in both directions, and its counts replace
 * the references' tier once they cover enough parcels.
 */
import data from './coverage.json' with { type: 'json' };
import type { UniversalSource } from './types.js';

export type CoverageAnswer = 'history' | 'no_history' | 'summary_only' | 'undated' | 'sign_in' | 'postcode_prompt'
  | 'wrong_carrier' | 'refused' | 'subscriber_only' | 'error' | 'blocked' | 'unverified' | 'n/a';
/** History rows, an answer, or history marked partial with the reason. */
export type CoverageCell = number | CoverageAnswer | { rows: number; partial: string };
export interface CoverageReference {
  /** What this extra reference is; the first one is the table's comparison reference. */
  note?: string;
  /** Too old for a negative to say anything about current coverage. */
  stale?: boolean;
  results: Partial<Record<UniversalSource, CoverageCell>>;
}
export interface CarrierCoverage {
  carrier: string;
  /** Table name, when it differs from the catalog's display name. */
  name?: string;
  /** The table's direct-support and direct-sample cells. */
  direct: string;
  sample: string;
  references: CoverageReference[];
}
export type CoverageTier = 'full' | 'partial' | 'unknown' | 'empty' | 'excluded';

/**
 * A consumer's own count of one carrier's parcels at one provider, each parcel
 * counted once, over a period the consumer chooses. A lookup no source had
 * history for says nothing about the provider and is not counted.
 */
export interface ObservedCoverage {
  /** Parcels the provider returned history for. */
  history: number;
  /** Parcels it had no history for in a lookup where another source did. */
  missed: number;
}

/** The providers every carrier's comparison reference states, COVERAGE.md's columns. */
export const COVERAGE_SOURCES: readonly UniversalSource[] = ['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU'];
/** Those, and Track123: references name it only for the carriers whose courier page was asked. */
const GRADED_SOURCES: readonly UniversalSource[] = [...COVERAGE_SOURCES, 'Track123'];
const ANSWERS = new Set<string>(['history', 'no_history', 'summary_only', 'undated', 'sign_in', 'postcode_prompt',
  'wrong_carrier', 'refused', 'subscriber_only', 'error', 'blocked', 'unverified', 'n/a']);
const EMPTY = new Set<CoverageCell>(['no_history', 'summary_only', 'undated', 'sign_in', 'postcode_prompt']);

export const CARRIER_COVERAGE: readonly CarrierCoverage[] = data.carriers as CarrierCoverage[];
const BY_CARRIER = new Map(CARRIER_COVERAGE.map((entry) => [entry.carrier, entry]));

export function isHistory(cell: CoverageCell | undefined): boolean {
  return typeof cell === 'number' || cell === 'history' || (typeof cell === 'object' && cell !== null);
}

/** The problems of one coverage entry, empty when it is valid. */
export function coverageProblems(entry: CarrierCoverage): string[] {
  const problems: string[] = [];
  if (!entry.references.length) problems.push('no reference');
  for (const [index, reference] of entry.references.entries()) {
    for (const [source, cell] of Object.entries(reference.results)) {
      if (!GRADED_SOURCES.includes(source as UniversalSource)) problems.push(`reference ${index + 1}: unknown source ${source}`);
      const valid = typeof cell === 'number' ? Number.isInteger(cell) && cell > 0
        : typeof cell === 'string' ? ANSWERS.has(cell)
          : typeof cell === 'object' && cell !== null && Number.isInteger(cell.rows) && cell.rows > 0
            && typeof cell.partial === 'string' && cell.partial.length > 0;
      if (!valid) problems.push(`reference ${index + 1}: invalid ${source} result ${JSON.stringify(cell)}`);
    }
  }
  return problems;
}

function tierOf(source: UniversalSource, references: readonly CoverageReference[]): CoverageTier {
  const seen = references.filter((reference) => reference.results[source] !== undefined);
  // A courier the provider keeps for its subscribers: no anonymous lookup can answer, whatever it once did.
  if (seen.some((reference) => reference.results[source] === 'subscriber_only')) return 'excluded';
  // A reference another provider knew, which this one did not.
  const missed = seen.some((reference) => !reference.stale
    && (EMPTY.has(reference.results[source]!) || reference.results[source] === 'wrong_carrier')
    && Object.entries(reference.results).some(([other, cell]) => other !== source && other !== 'UPU' && isHistory(cell)));
  if (seen.some((reference) => isHistory(reference.results[source]))) {
    const marked = seen.some((reference) => typeof reference.results[source] === 'object');
    return marked || missed ? 'partial' : 'full';
  }
  if (seen.some((reference) => ['wrong_carrier', 'refused'].includes(reference.results[source] as string))) return 'excluded';
  return seen.some((reference) => !reference.stale && EMPTY.has(reference.results[source]!)) ? 'empty' : 'unknown';
}

/** Fewer parcels than this say nothing about a provider. */
const OBSERVED_PARCELS = 10;

/**
 * The tier a consumer's counts give a provider, or null when they cover too few
 * parcels: history for four parcels in five is `full`, for one in five
 * `partial`, for fewer `empty`, and for none `excluded`.
 */
function observedTier(seen: ObservedCoverage | undefined): CoverageTier | null {
  const count = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? value! : 0;
  const history = count(seen?.history);
  const parcels = history + count(seen?.missed);
  if (parcels < OBSERVED_PARCELS) return null;
  const rate = history / parcels;
  return rate >= 0.8 ? 'full' : rate >= 0.2 ? 'partial' : rate > 0 ? 'empty' : 'excluded';
}

/**
 * Each provider's tier for a carrier, or null when nothing says anything about
 * it: no reference, and no count of `observed` that covers enough parcels.
 *
 * A count replaces the tier the references give, except where it cannot see
 * what they saw: a provider they exclude stays out (another carrier's parcel
 * counts as history), and history they mark partial stays partial (a count
 * sees parcels, not rows).
 */
export function coverageTiers(
  carrier: string | null | undefined,
  observed?: Partial<Record<UniversalSource, ObservedCoverage>>,
): Record<UniversalSource, CoverageTier> | null {
  const references = (carrier ? BY_CARRIER.get(carrier) : undefined)?.references;
  const counted = (Object.keys(observed ?? {}) as UniversalSource[]).filter((source) => observedTier(observed![source]));
  if (!references && !counted.length) return null;
  return Object.fromEntries([...new Set([...GRADED_SOURCES, ...counted])].map((source) => {
    const stated = tierOf(source, references ?? []);
    const seen = observedTier(observed?.[source]);
    if (!seen || stated === 'excluded') return [source, stated];
    const marked = references?.some((reference) => typeof reference.results[source] === 'object');
    return [source, seen === 'full' && marked ? 'partial' : seen];
  })) as Record<UniversalSource, CoverageTier>;
}
