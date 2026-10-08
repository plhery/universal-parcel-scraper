import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

// Office labels that name a Chronopost service, not where the scan happened:
// the shipper's labelling system on preparation scans, the notification
// service on SMS and e-mail notices, and the partner network abroad.
const SERVICES = new Set(['web services', "service d'avisage", 'chronopost networks']);

/** Whether an office label names one of Chronopost's services rather than a place. */
export function isChronopostService(label: string): boolean {
  return SERVICES.has(label.replace(/\s+/g, ' ').trim().replace(/’/g, "'").toLocaleLowerCase('fr-FR'));
}

// Scans stored with a service as their location lose it and keep their row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'chronopost', storedSources: ['chronopost'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isChronopostService),
};
