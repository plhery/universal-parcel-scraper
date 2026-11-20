import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The rows Transglobal writes for its own booking and collection, and the partner couriers' rows
// it relays in their words. Only wordings seen on its result page are mapped.
const WORDINGS: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^booking made$/, 'registered'],
  [/^parcel created$/, 'registered'],
  // "Collected by <driver> (Transglobal)".
  [/^collected by [^()]{1,80} \(transglobal\)$/, 'accepted'],
  [/^processed at origin depot$/, 'in_transit'],
  [/^we've received this parcel at the hub and will be sorted to the customers delivery depot$/, 'in_transit'],
  [/^parcel processed at the (?:hub|depot)$/, 'in_transit'],
  [/^this parcel is on its way to the courier$/, 'in_transit'],
  [/^the item has been received by the courier and will be out for delivery soon\.?$/, 'in_transit'],
  // Written minutes after the morning's receipt at the delivering depot: a day without a round, not a missed delivery.
  [/^we're unable to deliver this parcel today\. we will now deliver the next working day\.?$/, 'in_transit'],
];

const comparable = (wording: string): string => wording.normalize('NFKC').replace(/[‘’]/g, "'")
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** The stage of a row the map knows; undefined for any other wording. */
export function transglobalMappedStage(wording: string): Stage | undefined {
  const text = comparable(wording);
  return WORDINGS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else none. */
export function transglobalStage(wording: string): ClassifiedWording | null {
  const mapped = transglobalMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : transglobalMappedStage(wording)),
  gaps: [],
};
