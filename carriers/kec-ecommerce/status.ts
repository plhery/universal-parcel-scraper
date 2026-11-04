import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const key = (code: string | null, wording: string) => JSON.stringify([code, normalizeStatusWording(wording)]);
const ROWS = new Map<string, Stage>((statuses.entries as readonly { code: string; wording: string; stage: string }[])
  .map(entry => [key(entry.code, entry.wording), entry.stage as Stage]));

/** Delivery-attempt category names can label depot sorting; the whole code/wording pair decides. */
export function kecStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = ROWS.get(key(code, wording));
  if (stage) return { stage, source: 'carrier_map' };
  const inferred = classifyWording(wording, 'pending');
  return inferred.source === 'none' ? null : inferred;
}

export const statusMap: CarrierStatusMap = { stage: (code, wording) => ROWS.get(key(code, wording)), gaps: [] };
