import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

/** The wording of a signature that is the recipient's. */
export const HANDOVER_WORDING = statuses.entries.find(entry => entry.code === 'YES')!.wording;
const HANDOVER = normalizeStatusWording(HANDOVER_WORDING);

/** The stage Fastway's table gives a scan code. */
export function fastwayCodeStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/**
 * The map reads a scan's code. A signature is a delivery only with the explicit delivered wording.
 * The parser also reads a pickup after the parcel has reached the network as in transit.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (!code || (code === 'YES' && wording !== HANDOVER) ? undefined : fastwayCodeStage(code)),
  gaps: [],
  gapNote: (code, wording) => (code === 'YES' && wording !== HANDOVER
    ? 'A regional signature alone can be the on-forwarder\'s receipt, not the recipient\'s.' : undefined),
};
