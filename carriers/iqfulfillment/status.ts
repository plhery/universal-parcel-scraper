import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's milestones, each a fixed title with a fixed sentence under it.
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

/** The stage IQ Fulfillment's map gives a milestone's title. */
export function iqfulfillmentMappedStage(title: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(title));
}

/** A milestone's stage: the map, else the shared wording rules, else nothing. */
export function iqfulfillmentStage(title: string): ClassifiedWording | null {
  const mapped = iqfulfillmentMappedStage(title);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(title, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => iqfulfillmentMappedStage(wording), gaps: [], wholeWording: true };
