import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { code?: string; wording?: string; stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

// Every scan carries its event code, whose flow (warehouse or pickup point to a point or a door,
// a return) decides what one wording means: "Parcel out for delivery" heads to a pickup point in
// one flow and to the door in another.
const CODES = new Map<string, Stage>(ENTRIES.flatMap((entry) => (entry.code ? [[entry.code, entry.stage as Stage] as const] : [])));

// A wording without a code, as an earlier tracker or a provider gives it, reads only where all the
// entries that word it agree on one stage.
const WORDINGS = (() => {
  const stages = new Map<string, Set<Stage>>();
  for (const entry of ENTRIES) {
    if (!entry.wording) continue;
    const key = normalizeStatusWording(entry.wording);
    stages.set(key, (stages.get(key) ?? new Set()).add(entry.stage as Stage));
  }
  return new Map([...stages].flatMap(([key, set]) => (set.size === 1 ? [[key, [...set][0]!] as const] : [])));
})();

/** A scan's or the order's stage: its event code's, else the stage every entry with its wording shares. */
export function pargoStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  stage: pargoStage,
  gaps: [],
};
