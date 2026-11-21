import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .flatMap(entry => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

/** The stage of a step by its English wording. */
export const amassStage = (wording: string): Stage | undefined => BY_WORDING.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => BY_WORDING.get(wording),
  gaps: statuses.entries.flatMap(entry => entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note }]),
};
