import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STAGES = new Map<string, Stage>();
const GAPS = new Set<string>();
for (const entry of statuses.entries) {
  const key = normalizeStatusWording(entry.wording);
  if ('stage' in entry && entry.stage) STAGES.set(key, entry.stage as Stage);
  else GAPS.add(key);
}

/** The stage of a row's wording in Topparcel's map: its own steps and partners' wording it relays. */
export function topparcelMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/**
 * A row's stage: its wording in the map, else the shared wording rules, which read the steps
 * couriers name in English. A notice in the map, or wording no rule reads, has none.
 */
export function topparcelStage(wording: string): ClassifiedWording | null {
  const mapped = topparcelMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads a row's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => topparcelMappedStage(wording),
  gaps: statuses.entries.flatMap((entry) => ('stage' in entry && entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note! }])),
};
