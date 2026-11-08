import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The statuses J&T Express China heads its scans with, as `statuses.json` records them from the
 * tracker page's script and reports; another status falls to the wording rules.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map((statuses.entries as readonly { wording: string; stage: string }[])
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage J&T Express China's statuses give a scan. */
export function jAndTCnMappedStage(label: string): Stage | undefined {
  return LABELS.get(normalizeStatusWording(label));
}

/** A scan's stage: its status, else the shared wording rules, else nothing. */
export function jAndTCnStage(label: string): ClassifiedWording | null {
  const mapped = jAndTCnMappedStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jAndTCnMappedStage(wording),
  gaps: [],
};
