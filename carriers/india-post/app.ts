import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// MySpeedPost changes a scan's wording while its instant and event_type stay the same.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: true,
};
