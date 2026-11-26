import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

const WORDINGS = new Map(ENTRIES.flatMap(entry => entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

/** An instruction recorded on the consignment, such as the recipient's authority to leave it: no scan, so no stage. */
const GAPS = ENTRIES.filter(entry => entry.unmapped).map(entry => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map(gap => gap.wording));

export function directFreightStage(wording: string): ClassifiedWording | null {
  const normalized = normalizeStatusWording(wording);
  if (GAP_WORDINGS.has(normalized)) return null;
  const stage = WORDINGS.get(normalized);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
export const statusMap: CarrierStatusMap = { stage: (code, wording) => code ? undefined : WORDINGS.get(normalizeStatusWording(wording)), gaps: GAPS };
