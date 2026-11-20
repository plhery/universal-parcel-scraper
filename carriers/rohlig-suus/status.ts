import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The guest tracker's visible events, by their numeric id, from the dictionary the page reads
 * (`visibility-events/entries`). An id outside it is one the page hides.
 */
export const SUUS_EVENTS: ReadonlyMap<string, { wording: string; stage?: Stage }> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, ...(entry.stage ? { stage: entry.stage as Stage } : {}) }]));

const CODES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.stage).map((entry) => [entry.code, entry.stage as Stage]));

// A wording shared by several ids keeps its stage only when they all agree.
const WORDINGS: ReadonlyMap<string, Stage> = (() => {
  const stages = new Map<string, Set<string>>();
  for (const entry of statuses.entries) {
    const key = normalizeStatusWording(entry.wording);
    stages.set(key, (stages.get(key) ?? new Set()).add(entry.stage ?? ''));
  }
  return new Map([...stages].filter(([, set]) => set.size === 1 && !set.has(''))
    .map(([wording, set]) => [wording, [...set][0] as Stage]));
})();

/** The stage of a visible event id; billing, notes and estimates have none. */
export function rohligSuusStage(code: string): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : undefined) ?? (code && SUUS_EVENTS.has(code) ? undefined : WORDINGS.get(wording)),
  gaps: statuses.entries.filter((entry) => entry.unmapped)
    .map((entry) => ({ code: entry.code, note: entry.note ?? 'Rohlig SUUS Logistics leaves it unmapped on purpose.' })),
};
