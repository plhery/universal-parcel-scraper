import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Aquantuo's step names, from its tracking page and its status guide. A name without a stage
// is a mark the page puts on the step before, and its note says so.
type Entry = { readonly wording: string; readonly stage?: string; readonly note: string };
const ENTRIES = statuses.entries as readonly Entry[];
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES.flatMap(entry => (entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : [])));

/** The stage of a step by its name, which the page writes in either case. */
export const aquantuoStage = (name: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(name));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : BY_WORDING.get(wording)),
  gaps: ENTRIES.flatMap(entry => (entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note }])),
  wholeWording: true,
};
