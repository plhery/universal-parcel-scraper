import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The stages of the operations Hainan Airlines Cargo's tracker lists, as recorded in `statuses.json`. */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));

export function hainanCargoMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

/** A scan's stage: its operation, else the shared wording rules, else nothing. */
export function hainanCargoStage(wording: string): ClassifiedWording | null {
  const mapped = hainanCargoMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? hainanCargoMappedStage(code) : undefined),
  gaps: [],
};
