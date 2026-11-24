import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { statusMap as dpd } from '../dpd/status.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries.filter(entry => !('code' in entry)));

/**
 * Geopost's guest API answers under DPD's codes, which DPD's map stages, and the codes it leaves
 * unmapped stay so. A scan without a code, from Jadlog's own tracker or as providers relay it, reads
 * Jadlog's Portuguese wording.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? dpd.stage(code, wording) : WORDINGS.stage(normalizeStatusWording(wording))),
  gaps: dpd.gaps.filter(gap => gap.code !== undefined),
};
