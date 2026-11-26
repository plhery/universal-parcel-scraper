import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

/** The stage TOPEST's map gives a row's whole wording. */
export function topestMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function topestStage(wording: string): ClassifiedWording | null {
  const mapped = topestMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => topestMappedStage(wording), gaps: [], wholeWording: true };
