import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The labels J&T Express Mexico lists its scans under, as `statuses.json` records them. Only labels
 * seen in replies are mapped; another label falls to the wording rules.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map((statuses.entries as readonly { wording: string; stage: string }[])
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage J&T Express Mexico's labels give a scan. */
export function jAndTMxMappedStage(label: string): Stage | undefined {
  return LABELS.get(normalizeStatusWording(label));
}

/** A scan's stage: its label, else the shared wording rules, else nothing. */
export function jAndTMxStage(label: string): ClassifiedWording | null {
  const mapped = jAndTMxMappedStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => jAndTMxMappedStage(wording),
  gaps: [],
};
