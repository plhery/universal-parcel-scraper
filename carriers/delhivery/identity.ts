import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Delhivery restates a scan at its instant in the same words and place. A freight milestone names
 * no place, and Delhivery relabels one when the shipment turns back: "On the Way" becomes
 * "Undelivered" at the same date once it returns to the seller. A placeless row is taken over by a
 * placeless scan at its instant, when the match is unique both ways.
 */
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'delhivery', storedSources: ['delhivery'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => wording(incoming) !== '' && wording(stored) !== ''
    && incoming.location.trim() === stored.location.trim()
    && (incoming.location.trim() === '' || wording(incoming) === wording(stored)),
};
