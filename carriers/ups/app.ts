import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

// UPS can add a location later. Its wording distinguishes scans sharing a clock.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'ups', storedSources: ['ups'], requireProviderCode: false,
  matches(incoming, stored) {
    const wording = normalized(incoming.description);
    const location = normalized(incoming.location);
    const savedLocation = normalized(stored.location);
    return incoming.stage !== '' && incoming.stage !== 'unknown' && incoming.stage === stored.stage
      && wording !== '' && wording === normalized(stored.description)
      && (!location || !savedLocation || location === savedLocation);
  },
};
