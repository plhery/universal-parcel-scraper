import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { decodeEntities } from './text.js';

/** Wording or a place as UPS shows it: scans stored before October 2026 kept its HTML escapes. */
function normalized(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

/**
 * Two readings of one activity. Scans stored before UPS's activity codes were
 * kept have none, and their stage came from their wording instead of the code.
 */
function sameActivity(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  if (incoming.providerCode && stored.providerCode) return incoming.providerCode === stored.providerCode;
  return incoming.providerCode !== '' || incoming.stage === stored.stage;
}

// UPS can add a location later. Its wording distinguishes scans sharing a clock.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'ups', storedSources: ['ups'], requireProviderCode: false,
  matches(incoming, stored) {
    const wording = normalized(incoming.description);
    const location = normalized(incoming.location);
    const savedLocation = normalized(stored.location);
    return incoming.stage !== '' && incoming.stage !== 'unknown' && sameActivity(incoming, stored)
      && wording !== '' && wording === normalized(stored.description)
      && (!location || !savedLocation || location === savedLocation);
  },
};
