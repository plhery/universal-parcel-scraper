import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation, matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';
import { isPostiAbroadLabel } from '../../carriers/posti/identity.js';

// A copy may add a place, or drop Posti's "abroad" label it was once stored with.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'unknown', storedSources: ['unknown'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored)
    || matchesDroppedLocation(incoming, stored, isPostiAbroadLabel),
};
