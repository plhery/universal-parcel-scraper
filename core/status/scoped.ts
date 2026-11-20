/**
 * Wording rules that hold for one carrier only, or for the copies one universal provider relays of
 * that carrier's scans: a word the carrier uses in a sense of its own, which the shared rules leave
 * open, or read otherwise, for everyone else.
 */
import type { Stage } from '../../generated/catalog.js';
import { normalizeStatusWording } from './statusMap.js';

export interface ScopedWordingRule {
  /** The catalog carrier whose scans the rule reads. */
  readonly carrier: string;
  /** The universal providers whose copies of the carrier's scans the rule reads; every source when absent. */
  readonly providers?: readonly string[];
  /** The whole wording, as `normalizeStatusWording` writes it. */
  readonly wording: string;
  readonly stage: Stage;
  /** Why the carrier's word reads so. */
  readonly note: string;
}

export const SCOPED_WORDINGS: readonly ScopedWordingRule[] = [
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'returns', stage: 'failed_attempt',
    note: "BUFFALO's parcel back at its depot undelivered after a round, as ParcelsApp relays it: each came the evening after a "
      + "vehicle departure, the parcel left again the next morning, and after four such rounds it went back to the sender. "
      + "Elsewhere the bare word can name a return to the sender.",
  },
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'collected', stage: 'in_transit',
    note: "The local courier collecting a BUFFALO parcel from BUFFALO's depot, as ParcelsApp relays it: it came after the "
      + "customs release and the hubs, before the courier's first round. Elsewhere the word is the acceptance from the sender.",
  },
  {
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'scan vehicle departure', stage: 'out_for_delivery',
    note: "The local courier's delivery round on a BUFFALO parcel, as ParcelsApp relays it: each departure came early in the "
      + "morning, the parcel was back at the depot that evening, and no round ran on the Sunday. Elsewhere a vehicle can leave for another depot.",
  },
];

/** The carrier behind a scan and the provider that relayed it, when one did. */
export interface WordingScope {
  readonly carrier?: string | null;
  readonly provider?: string | null;
}

/** The stage a rule scoped to the scan's carrier, and to its provider where the rule names one, gives its whole wording. */
export function scopedWordingStage(description: string, scope: WordingScope): Stage | undefined {
  if (!scope.carrier) return undefined;
  const wording = normalizeStatusWording(description);
  return SCOPED_WORDINGS.find((rule) => rule.carrier === scope.carrier && rule.wording === wording
    && (!rule.providers || (!!scope.provider && rule.providers.includes(scope.provider))))?.stage;
}
