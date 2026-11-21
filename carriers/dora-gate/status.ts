import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * The tracking codes of AnserX's tracker on Dora Gate's scans (`BTY_`, the leg
 * and its step), as recorded in `statuses.json`. The delivering carrier's
 * relayed scans carry no code and go through the shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function doraGateStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? CODES.get(code.toUpperCase()) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a scan code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code.toUpperCase()) : undefined),
  gaps: [],
};
