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
    carrier: 'buffalo-ex', providers: ['ParcelsApp'], wording: 'returns', stage: 'in_transit',
    note: "BUFFALO's parcel back at its depot after a round, as ParcelsApp relays it: each came the evening after a vehicle "
      + "departure, and the parcel left again the next morning. Elsewhere the bare word can name a return to the sender.",
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
