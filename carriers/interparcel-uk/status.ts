import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The status letters of Interparcel's summary, and the wording of its own steps that the
// summary leaves out; every Interparcel site uses them. A letter's note without a stage says
// why it sets none.
const BY_CODE = new Map<string, Stage>();
const BY_WORDING = new Map<string, Stage>();
const CODE_GAPS = new Map<string, string>();
type Entry = { readonly code?: string; readonly wording: string; readonly stage?: string; readonly note: string };
for (const entry of statuses.entries as readonly Entry[]) {
  const stage = entry.stage as Stage | undefined;
  if (entry.code) {
    if (stage) BY_CODE.set(entry.code, stage);
    else CODE_GAPS.set(entry.code, entry.note);
  } else if (stage) BY_WORDING.set(normalizeStatusWording(entry.wording), stage);
}

/**
 * A row's stage: its status letter where the summary gives one, else its wording in the map,
 * else the shared wording rules, which read the steps couriers name in English. A letter that
 * sets no stage leaves its row without one.
 */
export function interparcelStage(code: string | null, wording: string): ClassifiedWording | null {
  if (code) {
    const stage = BY_CODE.get(code);
    return stage ? { stage, source: 'carrier_map' } : null;
  }
  const mapped = BY_WORDING.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? BY_CODE.get(code) : BY_WORDING.get(wording)),
  gaps: [...CODE_GAPS].map(([code, note]) => ({ code, note })),
};
