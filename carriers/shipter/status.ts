import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** Partner rows repeat a depot before the wording; towns and hubs are variable. */
export function shipterScanKey(wording: string): string {
  const text = wording.replace(/^([^,]{1,100}), \1, (your .+)$/, '$2');
  return text.replace(/^(your parcel is currently in transit to )[^.]+\.\.$/, '$1…')
    .replace(/^(your parcel has been received at )[^.]+( depot\.\.)$/, '$1…$2')
    .replace(/^(parcel received in processing centre \()[^)]+\)$/, '$1…)')
    .replace(/^(parcel depart from )[^.]+( depot)$/, '$1…$2')
    .replace(/^(the item is ready for shipment)[a-z][a-z -]*$/, '$1…');
}

export const shipterStage = (_code: string | null, wording: string): Stage | undefined => WORDINGS.get(shipterScanKey(wording));

export const statusMap: CarrierStatusMap = { stage: shipterStage, gaps: [] };
