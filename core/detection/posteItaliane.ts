import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';

/** Catalog shape eligibility; a matching Poste lookup must still establish the shipment. */
export function isPosteItalianeTrackingNumber(number: string): boolean {
  return CARRIER_DEFINITIONS['poste-italiane'].detectionRules.some(rule => new RegExp(rule.pattern).test(number));
}
