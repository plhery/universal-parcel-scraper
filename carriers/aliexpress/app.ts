import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// A scan stored while its town was still part of the wording, "[Bordeaux] Out for
// delivery" without a location, is the same scan as "Out for delivery" in Bordeaux.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'aliexpress', storedSources: ['aliexpress'], requireProviderCode: false,
  matchEachScan: true,
  matches(incoming, stored) {
    const wording = normalized(incoming.description);
    const location = normalized(incoming.location);
    return Boolean(wording && location) && !['', 'unknown'].includes(incoming.stage)
      && incoming.stage === stored.stage && !normalized(stored.location)
      && normalized(stored.description) === `[${location}] ${wording}`;
  },
};
