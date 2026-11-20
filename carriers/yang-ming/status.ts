import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Yang Ming words each event as the DCSA standard does: the event, whether the container is
// empty or laden, the mode and the facility, as "Gate out of Empty Equipment by Truck at Depot".
const EQUIPMENT = /^(gate out|gate in|load|discharge) of (empty|laden) equipment (?:by|onto|from) (\w+)\b/;
const TRANSPORT = /^(?:arrival|departure) by \w+\b/;

/**
 * The stage of an event by its wording. An empty container leaves for the shipper and comes back
 * once unloaded; a laden one enters the terminal, moves, and leaves by truck to the consignee or
 * by rail or barge further inland. Moving an empty container is no move of the shipment.
 */
export function yangMingStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  if (TRANSPORT.test(text)) return 'in_transit';
  const parts = EQUIPMENT.exec(text);
  if (!parts) return undefined;
  const [, action, load, mode] = parts;
  if (load === 'empty') return action === 'gate out' ? 'registered' : action === 'gate in' ? 'delivered' : undefined;
  if (action === 'gate in') return 'accepted';
  if (action === 'gate out') return mode === 'truck' ? 'out_for_delivery' : 'in_transit';
  return 'in_transit';
}

const EMPTY_MOVE = /^(?:load|discharge) of empty equipment\b/;

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => yangMingStage(wording),
  gaps: [],
  gapNote: (_code, wording) => EMPTY_MOVE.test(normalizeStatusWording(wording))
    ? 'An empty container moved on a vessel, rail or barge is repositioned for its next shipment, not moving this one.' : undefined,
};
