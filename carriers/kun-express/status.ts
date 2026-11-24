import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage Kun Express's map gives one of its own rows, by its `normalizeStatusWording`
 * wording. The warehouse's departure can name its place after "货物离开" (the goods left). The
 * rows it copies from USPS are left to the shared wording rules, except the USPS acceptance the
 * map lists: it comes after the flight, long after the warehouse accepted the parcel.
 */
export function kunExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (wording.startsWith('货物离开') ? 'in_transit' : undefined);
}

export const statusMap: CarrierStatusMap = { stage: kunExpressStage, gaps: [] };
