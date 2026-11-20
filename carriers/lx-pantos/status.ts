import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Each scan carries an event code beside its English wording.
const CODES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage] as const));

/** A scan's stage by its code, else by the shared rules for its wording. */
export function pantosStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? CODES.get(code) : undefined),
  gaps: [],
};
