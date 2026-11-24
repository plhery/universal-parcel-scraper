import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Dnipro LLC's event codes, as its tracking page's script groups them, with the stage each means.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

function mapped(code: string | null): Stage | undefined {
  return code === null ? undefined : CODED.get(code);
}

/**
 * An event's stage by its code. A code the page does not group is staged by the shared rules on
 * its message, else left without a stage, which keeps it visible for review.
 */
export function dniproEventStage(code: string | null, message: string): ClassifiedWording | null {
  const stage = mapped(code);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(message, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Events are staged by Dnipro LLC's code; their messages carry the number and are not mapped whole. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => mapped(code),
  gaps: [],
};
