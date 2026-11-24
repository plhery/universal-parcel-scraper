import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each event by a Cargo-IMP code, or a code of its own for a hold, beside its
// description. The code sets the stage.
const CODED: ReadonlyMap<string, Stage | null> = new Map(statuses.entries
  .map((entry) => [entry.code, entry.stage as Stage | null]));

/** An event's stage from its code, else the shared rules on its description, else nothing, which keeps it visible for review. */
export function latamStage(code: string, description: string): ClassifiedWording | null {
  const stage = CODED.get(code.toUpperCase());
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code.toUpperCase()) ?? undefined : undefined),
  gaps: statuses.entries.filter((entry) => entry.stage === null).map((entry) => ({ code: entry.code, note: entry.note ?? '' })),
};
