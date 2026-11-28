import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { withoutCountryCode, withoutRelayedPlace, withoutRepeat } from './place.js';

const wording = (description: string) => description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan, by its wording and place. Shouwu's scans have no code. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const read = wording(incoming.description);
  return read !== '' && (read === wording(stored.description) || read === wording(withoutRelayedPlace(stored.description.trim()))
    || read === wording(withoutRepeat(stored.description)))
    && incoming.location.trim() === stored.location.trim();
}

// Earlier releases read each epoch as the scan's instant. It is the scan's wall
// clock read on Beijing time, so a scan abroad now shows that wall clock under
// its place's offset and takes over the row stored from it. A row stored with
// the country's code before its place is taken over by the place without it,
// and a FedEx row stored with its town and postcode before its wording by the
// wording without them. A row stored with its wording said twice is taken over by
// the wording said once.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'shouwu', storedSources: ['shouwu'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => sameScan(incoming, stored) || matchesRereadLocation(incoming, stored, withoutCountryCode),
  relabelledFrom: 'Asia/Shanghai',
};
