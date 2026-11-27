/**
 * A kdfei tenant's status map, apart from the request and reader so the catalog's status maps load it in the
 * browser.
 */
import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export interface KdfeiEntry {
  readonly code: string;
  readonly wording: string;
  readonly stage: string;
}

/**
 * A tenant's status map from its `statuses.json`: the platform's state (`code`) with the row's text. A state
 * whose every recorded text means one stage gives it to a text the map does not know.
 */
export function kdfeiStatusMap(entries: readonly KdfeiEntry[]): CarrierStatusMap {
  const key = (state: string | null, wording: string) => JSON.stringify([state ?? '', normalizeStatusWording(wording)]);
  const mapped = new Map(entries.map((entry) => [key(entry.code, entry.wording), entry.stage as Stage]));
  const stages = new Map<string, Set<Stage>>();
  for (const entry of entries) stages.set(entry.code, (stages.get(entry.code) ?? new Set<Stage>()).add(entry.stage as Stage));
  const byState = new Map([...stages].filter(([, set]) => set.size === 1).map(([state, set]) => [state, [...set][0]!]));
  return {
    stage: (state, wording) => mapped.get(key(state, wording)) ?? (state ? byState.get(state) : undefined),
    gaps: [],
  };
}
