import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry): entry is typeof entry & { stage: string } => 'stage' in entry)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage of a movement by Yol Kargo's map, else by the wording itself; none when the wording says nothing. */
export function yolStage(wording: string): ClassifiedWording | null {
  const mapped = WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

/** Yol Kargo's movements carry wording and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : WORDINGS.get(wording),
  gaps: [],
};
