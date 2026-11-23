import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// Rows whose wording carries the shipment's own details: the warehouse's city, the vessel and its
// dates, or FedEx's note of where it left the parcel.
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  [/^[a-z ]+, [a-z ]+, arrival at outward office of exchange$/u, 'accepted'],
  [/^【cn】您的订单预计.*开船/u, 'in_transit'],
  [/^【cn】您的订单已开船/u, 'in_transit'],
  [/^已送达[,，]/u, 'delivered'],
];

/**
 * The stage YJI's map gives one of its rows, by its `normalizeStatusWording` wording: the
 * forwarder's own rows and notes, the platform's script and the FedEx rows the tracker copies in
 * FedEx's Chinese.
 */
export function yjiStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? PATTERNS.find(([pattern]) => pattern.test(wording))?.[1];
}

export const statusMap: CarrierStatusMap = { stage: yjiStage, gaps: [] };
