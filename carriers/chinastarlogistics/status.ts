/**
 * Huaxin's nodes: a code and a fixed name for each step of a waybill, beside a text whose status
 * the adapter shows. An entry of `statuses.json` records a code, its name and its stage; a code
 * the map does not know goes through the shared wording rules, the name first, then the status.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const CODES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

export const statusMap: CarrierStatusMap = { stage: (code) => (code ? CODES.get(code) : undefined), gaps: [] };

/** A node's stage, by its code, else by the shared wording rules on its name and then its status, or none. */
export function chinastarStage(code: string, name: string, status = ''): ClassifiedWording | null {
  const stage = CODES.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  for (const wording of [name, status]) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}
