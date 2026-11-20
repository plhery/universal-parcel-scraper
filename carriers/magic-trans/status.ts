import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The page's dated rows carry codes; the cargo status is a wording.
const CODES = new Map(statuses.entries.flatMap(entry => 'code' in entry && entry.code ? [[entry.code, entry.stage as Stage] as const] : []));
const WORDINGS = new Map(statuses.entries.flatMap(entry => 'code' in entry && entry.code ? []
  : [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const]));
/** The wording each dated row's event takes, by its code. */
export const MILESTONES = new Map(statuses.entries.flatMap(entry => 'code' in entry && entry.code ? [[entry.code, entry.wording] as const] : []));

/** The stage of a dated row by its code, else of the cargo status by its wording, else by shared wording rules. */
export function magicTransStage(code: string | undefined, wording: string): ClassifiedWording | null {
  const mapped = code ? CODES.get(code) : WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code) return null;
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: [],
};
