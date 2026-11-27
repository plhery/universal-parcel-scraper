/**
 * HD Express's rows: a fixed wording for each step its system's `state` counts, kept as the scan's
 * code. An entry of `statuses.json` records the two; anything else goes through the shared
 * wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const key = (code: string | null | undefined, wording: string) => JSON.stringify([code ?? '', normalizeStatusWording(wording)]);
const MAPPED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = { stage: (code, wording) => MAPPED.get(key(code, wording)), gaps: [] };

/** A row's stage, by its `state` and wording, else by the shared wording rules, or none. */
export function hdExpressStage(wording: string, code = ''): ClassifiedWording | null {
  const stage = MAPPED.get(key(code, wording));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
