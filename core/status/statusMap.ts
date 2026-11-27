/**
 * What a carrier's own status map says about one scan, asked by its provider
 * code and wording instead of a whole reply. A carrier declares this next to
 * its map; `core/catalog/statusMaps.ts` collects the declarations for the
 * parcel app, which reviews the wording no map staged.
 */
import type { Stage } from '../../generated/catalog.js';

/** A code or wording the carrier's map gives no stage on purpose. */
export interface IntentionalStatusGap {
  /** The provider code. Without one, the gap covers only wording that came without a code. */
  readonly code?: string;
  /** The wording in `normalizeStatusWording` form. Without one, the gap covers every wording of its code. */
  readonly wording?: string;
  /**
   * Why the map leaves it without a stage. A notice the adapter gives no stage
   * says it keeps the stage of the scan before it: the parcel app restages the
   * scans it stored on those words.
   */
  readonly note: string;
}

export interface CarrierStatusMap {
  /** The part of a provider code the map reads, when not the whole code. Gaps name codes in this form. */
  readonly codeKey?: (code: string) => string;
  /**
   * The stage the map gives a scan with this provider code (null without one)
   * and wording in `normalizeStatusWording` form, or undefined when the code
   * and wording alone do not get one.
   */
  readonly stage: (code: string | null, wording: string) => Stage | undefined;
  readonly gaps: readonly IntentionalStatusGap[];
  /**
   * Why the map leaves a scan without a stage on purpose, by the same code and
   * wording, for gaps `gaps` cannot list one by one, such as a notice that
   * carries a date; undefined for any other scan.
   */
  readonly gapNote?: (code: string | null, wording: string) => string | undefined;
  /**
   * Whether `stage` reads a wording that comes without a code whole, as the carrier words it, rather than by
   * keywords. A universal provider that names the carrier behind a scan then reads its wording by this map
   * (`relayedWordingStage`).
   */
  readonly wholeWording?: boolean;
  /**
   * Why the carrier's own answer reads the scans after a return began as the trip back to the sender: once its
   * map reads a scan as `returned`, the later movements are the return and the sender's delivery its end. A
   * universal provider's copy of the carrier's history reads them so too (`withReturnTrip`).
   */
  readonly returnTrip?: string;
}

/** Lower case, single spaces and at most 500 characters: the form the app keys its observations on. */
export function normalizeStatusWording(description: string): string {
  return description.toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ').slice(0, 500);
}

/**
 * Why the map leaves a scan without a stage on purpose, by its provider code (null without one) and
 * `normalizeStatusWording` wording, or undefined when it does not: a gap without a code covers only
 * wording that came without one, a gap without wording every wording of its code, and `gapNote` the
 * gaps the map cannot list.
 */
export function statusGapNote(map: CarrierStatusMap, code: string | null, wording: string): string | undefined {
  const key = code === null ? null : map.codeKey?.(code) ?? code;
  const gap = map.gaps.find((candidate) => (candidate.code ?? null) === key
    && (candidate.wording === undefined || candidate.wording === wording));
  return gap?.note ?? map.gapNote?.(code, wording);
}

/**
 * Sentences several carriers' trackers relay word for word, by `normalizeStatusWording` wording,
 * with the stage they have wherever they appear. A carrier's map consults this after its own.
 */
export const SHARED_WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The sender has not handed the parcel over yet. Dated after a movement, it reads as one
  // (`readLateRegistrations`).
  [normalizeStatusWording('Your package is being prepared by the sender and will be handed over to us soon'), 'registered'],
]);
