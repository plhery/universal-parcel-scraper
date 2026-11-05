import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { classifyDpdUkWording } from './parser.js';
import { isDpdUkNotice } from './wording.js';


/**
 * What the map says about one scan: DPD UK's scans carry no code, so their wording stages them
 * as the parser reads it, DPD UK's own wording first, then the shared rules. Wording neither
 * knows stays open, and so do the delivery notices.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => {
    const classified = classifyDpdUkWording(wording);
    return classified.source === 'none' ? undefined : classified.stage;
  },
  gaps: [],
  gapNote: (_code, wording) => (isDpdUkNotice(wording)
    ? 'A delivery notice, not a movement: the parcel keeps the stage it had.' : undefined),
};
