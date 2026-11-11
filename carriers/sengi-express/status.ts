import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;
const BY_CODE: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code && entry.stage)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** Sengi's event code where its record names one, else its English wording, else the shared wording rules. */
export function sengiExpressStage(wording: string, code: string): ClassifiedWording | null {
  const mapped = (code && BY_CODE.get(code)) || BY_WORDING.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && BY_CODE.get(code)) || BY_WORDING.get(normalizeStatusWording(wording)),
  gaps: [],
};
