import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Each step carries a numeric code beside its wording, which the service translates.
const CODES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage] as const));

/** A step's stage by its code, else by the shared rules for its wording. */
export function sparkStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? CODES.get(code) : undefined),
  gaps: [],
};
