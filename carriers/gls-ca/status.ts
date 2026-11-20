import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const STATUS_CODES = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));
const STATUS_NAMES = new Map<string, Stage>([
  ['shipment created', 'registered'],
  ['picked up', 'accepted'],
  ['in transit', 'in_transit'],
  ['on delivery', 'out_for_delivery'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage of a status name, an activity's or the shipment's. */
export function glsCanadaNameStage(name: string): Stage | undefined {
  return STATUS_NAMES.get(normalizeStatusWording(name));
}

/** An activity's stage: its code, else its status name. */
export function glsCanadaStage(code: string, status: string): Stage | undefined {
  return STATUS_CODES.get(code) ?? glsCanadaNameStage(status);
}

/**
 * The map reads a scan's code, else its wording as a status name. A scan keeps its status name
 * as its wording only when the activity has no detail.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => glsCanadaStage(code ?? '', wording),
  gaps: [],
};
