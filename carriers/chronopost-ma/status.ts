import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's events carry a French wording and no code.
const WORDINGS = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage] as const));

/** An event's stage by its wording, else by shared wording rules. */
export function chronopostMaStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(wording),
  gaps: [],
};
