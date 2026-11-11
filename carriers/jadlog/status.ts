import { statusWordings } from '../../core/status/english.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { statusMap as dpd } from '../dpd/status.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries.filter(entry => !('code' in entry)));

/**
 * Jadlog's lookups read the Geopost guest API, so DPD's codes stage their scans and the codes
 * DPD's map leaves unmapped stay so. A scan without a code, as providers relay Jadlog's own
 * tracker, reads Jadlog's Portuguese wording.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? dpd.stage(code, wording) : WORDINGS.stage(normalizeStatusWording(wording))),
  gaps: dpd.gaps.filter(gap => gap.code !== undefined),
};
