import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['Delivered', 'delivered'], ['Out for delivery', 'out_for_delivery'], ['Transit', 'in_transit'],
  ["En route to destination's port of entry", 'in_transit'], ['Departed connecting facility', 'in_transit'],
  ['Package in transit', 'in_transit'], ['Processed At Hub', 'in_transit'], ['Arrived At Hub', 'in_transit'],
  ['Request Received', 'registered'],
].map(([wording, stage]) => [normalizeStatusWording(wording!), stage as Stage]));

export function flickpostStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (normalized === normalizeStatusWording('Transit — Shipping Label Created')
    || normalized === normalizeStatusWording('Progress — Shipment created')) return 'registered';
  if (normalized === normalizeStatusWording("En route to destination's port of entry — Inbound for customs processing")
    || normalized === normalizeStatusWording('Processed At Hub — Outbound clearance in progress')) return 'customs';
  return STAGES.get(normalized.split(' — ', 1)[0]!);
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => flickpostStage(wording),
  gaps: [{ wording: normalizeStatusWording('Track and Trace'),
    note: 'A link to another tracking reference is an administrative entry, not a movement.' }],
};
