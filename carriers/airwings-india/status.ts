import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import evidence from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage: string }

// Recorded wordings, by code when the record has one, in `normalizeStatusWording` form.
const RULES = (evidence.entries as readonly Entry[]).map((entry) => ({ code: entry.code ?? '', wording: normalizeStatusWording(entry.wording),
  stage: entry.stage as Stage }));

/** A scan's stage: its code and wording as recorded, else the shared wording rules, else nothing. */
export function airwingsStage(code: string, wording: string): ClassifiedWording | null {
  const text = normalizeStatusWording(wording);
  const rule = RULES.find((candidate) => (!candidate.code || candidate.code === code) && candidate.wording === text);
  if (rule) return { stage: rule.stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads a scan as `airwingsStage` does, without the shared wording rules. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = airwingsStage(code ?? '', wording);
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};
