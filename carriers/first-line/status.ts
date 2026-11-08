import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// GOFO's delivery, which says where the parcel was left and then how to reach GOFO's support:
// "Delivered, Door/Yard. For delivery issues & tracking support, contact GOFO at …".
const GOFO_DELIVERED = /^delivered, [^.]{1,60}\. for delivery issues & tracking support, contact gofo\b/;

/**
 * The stage FIRST LINE's map gives a row, by its `normalizeStatusWording` wording. The
 * forwarder's own rows are mapped here; the delivering partner's, such as USPS's, are left to
 * the shared wording rules.
 */
export function firstLineStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (GOFO_DELIVERED.test(wording) ? 'delivered' : undefined);
}

/** The stage of one FIRST LINE row an aggregator relays, with its wording unchanged; a partner's row is left to the shared rules. */
export function firstLineScan(label: string): { stage: Stage; wording: string } | undefined {
  const stage = firstLineStage(null, normalizeStatusWording(label));
  return stage && { stage, wording: label };
}

export const statusMap: CarrierStatusMap = { stage: firstLineStage, gaps: [] };
