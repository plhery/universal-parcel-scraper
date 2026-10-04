import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'unknown', storedSources: ['unknown'], requireProviderCode: false,
  matchEachScan: true,
  matches: matchesLocationEnrichment,
};
