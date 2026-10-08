import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// Out-for-delivery scans read "Arrived at delivery center" until October 2026.
// The scan's instant and event code stay the same.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'amazon-shipping', storedSources: ['amazon-shipping'], requireProviderCode: true,
};
