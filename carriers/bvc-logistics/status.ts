/**
 * BVC Logistics' rows: a fixed English wording for each step, in the reply's `Location` field, which
 * the page also shows as the shipment's current status. An entry of `statuses.json` records each
 * wording seen; anything else goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const MAPPED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => MAPPED.get(normalizeStatusWording(wording)), gaps: [] };

/** A wording's stage from the map, else from the shared wording rules, or none. */
export function bvcStage(wording: string): ClassifiedWording | null {
  const stage = MAPPED.get(normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
