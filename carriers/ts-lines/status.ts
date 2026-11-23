import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// T.S. Lines words each container move as one fixed phrase, its typos included ("EMTY",
// "DISCHAREGED"). Some depots end the empty return with a full stop.
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['mty container out for vanning', 'registered'],
  ['emty container to cfs for stuffing', 'registered'],
  ['full turn in cy-outbound', 'accepted'],
  ['full container loaded on vessel', 'in_transit'],
  ['fcl container dischareged from vessel', 'in_transit'],
  ['full container out for devanning', 'out_for_delivery'],
  ['empty gate-in', 'delivered'],
  ['empty available gate in/change available/empty available', 'delivered'],
]);

/**
 * The stage of a move by its wording. An empty container leaves for the shipper's stuffing; the
 * full one enters the terminal, is loaded and discharged, and leaves for unloading; the empty one
 * comes back.
 */
export function tsLinesStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording).replace(/\.$/, ''));
}

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => tsLinesStage(wording),
  gaps: [],
};
