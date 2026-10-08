import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';

// A relayed scan stored without a place can take it from the UTC copy the
// adapter now drops.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'yanwen', storedSources: ['yanwen'], requireProviderCode: false,
  matchEachScan: true,
  matches: matchesLocationEnrichment,
};
