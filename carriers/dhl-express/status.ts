/**
 * DHL Express checkpoint wording. Both the guest mobile API and the public
 * web tracking send DHL's English checkpoint sentences, several of which end
 * with the facility ("Processed at PARIS - FRANCE"), so those are matched on
 * their fixed start. Other wording goes to the shared classifier.
 */
import { classifyWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const EXACT: ReadonlyMap<string, Stage> = new Map([
  ['shipment information received', 'registered'],
  ['shipment picked up', 'accepted'],
  ['shipment is in transit to destination', 'in_transit'],
  ['shipment is out with courier for delivery', 'out_for_delivery'],
  ['shipment is on hold', 'exception'],
  ['delivered', 'delivered'],
]);

const PREFIXES: ReadonlyArray<readonly [string, Stage]> = [
  ['delivery attempted', 'failed_attempt'],
  // A completed clearance puts the parcel back in transit; one still running stays in customs.
  ['clearance processing complete', 'in_transit'],
  ['clearance processing', 'customs'],
  ['customs clearance', 'customs'],
  ['processed at ', 'in_transit'],
  ['arrived at dhl sort facility', 'in_transit'],
  ['arrived at dhl delivery facility', 'in_transit'],
  ['shipment has departed from a dhl facility', 'in_transit'],
];

/** The checkpoint's stage from DHL's own wording, if the wording is one of DHL's checkpoints. */
export function dhlExpressCheckpointStage(description: string): Stage | undefined {
  const text = description.toLowerCase();
  return EXACT.get(text) ?? PREFIXES.find(([start]) => text.startsWith(start))?.[1];
}

export function dhlExpressStage(description: string): { stage: Stage; source: string } {
  const stage = dhlExpressCheckpointStage(description);
  return stage ? { stage, source: 'carrier_map' } : classifyWording(description, 'pending');
}

/** What the map says about one scan: the web feed's codes are not read, only the checkpoint wording. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => dhlExpressCheckpointStage(wording),
  gaps: [],
};
