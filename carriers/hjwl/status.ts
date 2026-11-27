/**
 * HJWL's nodes: a short status the operator gives each node, kept as the scan's code, beside a
 * message in their own words. An entry of `statuses.json` records a status and its stage;
 * anything else goes through the shared wording rules, the status first, then the message.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const CODES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

export const statusMap: CarrierStatusMap = { stage: (code) => (code ? CODES.get(code) : undefined), gaps: [] };

/** A node's stage, by its status, else by the shared wording rules on the status and then the message, or none. */
export function hjwlStage(status: string, message = ''): ClassifiedWording | null {
  const stage = CODES.get(status);
  if (stage) return { stage, source: 'carrier_map' };
  for (const wording of [status, message]) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}
