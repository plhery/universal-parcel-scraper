import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
export function bhPostaStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(normalizeStatusWording(wording)), gaps: [] };
