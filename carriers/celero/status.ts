import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Celero's statuses as its tracker writes them, in capitals. The manifest reaches Celero ahead of
 * the parcel, which customs then clear for delivery in Mauritius.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['manifest received', 'registered'],
  ['customs cleared', 'in_transit'],
]);

/** A status's stage: Celero's own where the map records it, else the shared rules on its wording. Null when nothing reads it. */
export function celeroStage(status: string): ClassifiedWording | null {
  const mapped = STATUSES.get(normalizeStatusWording(status));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(status, 'pending');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STATUSES.get(wording),
  gaps: [],
};
