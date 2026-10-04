import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'swiss-post', storedSources: ['swiss-post'], requireProviderCode: true,
  matchEachScan: true,
  matches: matchesLocationEnrichment,
};
