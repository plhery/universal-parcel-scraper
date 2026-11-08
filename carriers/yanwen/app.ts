import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { isKnownCarrierName } from '../../core/catalog/hints.js';
import { matchesLocationEnrichment } from '../../core/catalog/locationIdentity.js';
import { yanwenWording } from './status.js';

/**
 * Whether a relayed scan's place names none: a partner's placeholder ("Not Available"), a code of
 * one or two digits ("03"), or the partner's own name ("INPOST").
 */
export function isYanwenPlaceholder(location: string): boolean {
  const place = location.replace(/\s+/g, ' ').trim();
  return /^(?:not available|AA|\d{1,2})$/i.test(place) || isKnownCarrierName(place);
}

const same = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** A scan stored with a placeholder as its place, which the adapter now drops, at the same instant in the same words, whatever stage it was stored on. */
function droppedPlaceholder(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return !same(incoming.location) && Boolean(same(stored.location)) && isYanwenPlaceholder(stored.location)
    && Boolean(same(incoming.description)) && same(incoming.description) === same(stored.description)
    && !['', 'unknown'].includes(incoming.stage);
}

/** A J&T Australia scan stored with the customer service line the adapter now leaves out, on the same stage in the same place. */
function lostJAndTContact(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = yanwenWording(stored.description);
  return same(wording) !== same(stored.description) && same(wording) === same(incoming.description)
    && incoming.stage === stored.stage && same(incoming.location) === same(stored.location);
}

// A relayed scan stored without a place can take it from the UTC copy the
// adapter now drops, one stored with a placeholder as its place loses it and
// takes the stage the map now gives notices and handovers that came with one,
// and one stored with J&T Australia's customer service line loses that.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'yanwen', storedSources: ['yanwen'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored) || droppedPlaceholder(incoming, stored)
    || lostJAndTContact(incoming, stored),
};
