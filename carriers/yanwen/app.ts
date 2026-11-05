import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation, matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';
import { yanwenWording } from './status.js';

/** Whether a relayed scan's place is a partner's placeholder ("Not Available"), which names no place. */
export function isYanwenPlaceholder(location: string): boolean {
  return /^(?:not available|AA)$/i.test(location.replace(/\s+/g, ' ').trim());
}

const same = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** A J&T Australia scan stored with the customer service line the adapter now leaves out, on the same stage in the same place. */
function lostJAndTContact(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = yanwenWording(stored.description);
  return same(wording) !== same(stored.description) && same(wording) === same(incoming.description)
    && incoming.stage === stored.stage && same(incoming.location) === same(stored.location);
}

// A relayed scan stored without a place can take it from the UTC copy the
// adapter now drops, one stored with a placeholder as its place loses it, and
// one stored with J&T Australia's customer service line loses that.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'yanwen', storedSources: ['yanwen'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored) || matchesDroppedLocation(incoming, stored, isYanwenPlaceholder)
    || lostJAndTContact(incoming, stored),
};
