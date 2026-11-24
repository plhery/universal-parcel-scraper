import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's package status codes, from the operator's published source, and the event
// wordings its replies show. A code without a stage leaves the stage to the events.
type Entry = { readonly code?: string; readonly wording: string; readonly stage?: string; readonly note: string };
const ENTRIES = statuses.entries as readonly Entry[];
const BY_CODE = new Map<string, Stage>();
const CODE_GAPS = new Map<string, string>();
const BY_WORDING = new Map<string, Stage>();
for (const entry of ENTRIES) {
  const stage = entry.stage as Stage | undefined;
  if (entry.code) { if (stage) BY_CODE.set(entry.code, stage); else CODE_GAPS.set(entry.code, entry.note); }
  else if (stage) BY_WORDING.set(normalizeStatusWording(entry.wording), stage);
}

/** The stage of a package status code, or nothing for one that leaves it to the events. */
export const hitCargoStatus = (code: string): Stage | undefined => BY_CODE.get(code);

/** The stage of an event wording the tracker is known to write. */
export const hitCargoEventStage = (wording: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? BY_CODE.get(code) : BY_WORDING.get(wording)),
  gaps: [...CODE_GAPS].map(([code, note]) => ({ code, note })),
  wholeWording: true,
};
