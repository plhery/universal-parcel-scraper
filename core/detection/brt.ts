import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';

/** Complete identifiers accepted by BRT's shipment-number and parcel-label requests. */
export function isBrtTrackingNumber(number: string): boolean {
  return CARRIER_DEFINITIONS.brt.detectionRules.some(rule => new RegExp(rule.pattern).test(number));
}
