import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * The page's rows carry wording without a code: Polar Express's own, in Russian or English,
 * then those of the partner that carries the parcel on (Emirates Post's EMS, bpost, Boxberry)
 * in its words. The map is the wording recorded in `statuses.json`, then the openings below,
 * which a place, a day or a pallet's label follows.
 */
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .flatMap((entry) => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

const OPENINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^arrived moscow\. in customs\.?$/, 'customs'],
  // "Arrived Helsinki", "Arrived at GEORGIA", "Arrived in Brussels. …": a hub or country on the way.
  [/^arrived (?:at |in )?\S/, 'in_transit'],
  [/^shipped to \S/, 'in_transit'],
  [/^in transit to \S/, 'in_transit'],
  [/^grouped when pallet scanned to crossing\b/, 'in_transit'],
];

/** A notice that names a day: a delayed flight or the day the parcel should reach Moscow. */
const NOTICES: readonly (readonly [RegExp, string])[] = [
  [/^задержка вылета до \S/, 'A notice that the flight is delayed to the day it names; the parcel keeps the stage of the scan before.'],
  [/^ориентировочная дата прибытия в \S/, 'An estimate of the day the parcel reaches Moscow, not of its delivery; the parcel keeps the stage of the scan before.'],
];

const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));

/** The stage of a row by its wording, as the adapter keeps it. */
export function polarExpressStage(description: string): Stage | undefined {
  const wording = normalizeStatusWording(description);
  return BY_WORDING.get(wording) ?? OPENINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => polarExpressStage(wording),
  gaps: GAPS,
  gapNote: (code, wording) => (code === null ? NOTICES.find(([pattern]) => pattern.test(wording))?.[1] : undefined),
};
