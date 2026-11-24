import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker words each step in French and gives no code; a step at a depot has its place moved to the scan's location.
const ENTRIES = statuses.entries.map((entry) => ({ ...entry, key: normalizeStatusWording(entry.wording) }));
const STAGES = new Map<string, Stage>(ENTRIES.flatMap((entry) => (entry.stage ? [[entry.key, entry.stage as Stage] as const] : [])));

/** The stage of a step the tracker words, without the place it names; a step it never showed has none. */
export function planeteCourrierStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => STAGES.get(wording),
  gaps: ENTRIES.filter((entry) => !entry.stage).map((entry) => ({ wording: entry.key, note: entry.note ?? '' })),
};
