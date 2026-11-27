import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { jetspeedPlace } from './place.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// A release that reads a place in more of the rows' wordings gives a row its place, at the same
// instant on the tracker's one clock: the row stored without a place is that scan, when the place
// is the one its wording names ("About to be sent to the [Example] warehouse").
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'jetspeed', storedSources: ['jetspeed'], requireProviderCode: false, matchEachScan: true,
  matches(incoming, stored) {
    const wording = normalized(incoming.description);
    if (!wording || wording !== normalized(stored.description)) return false;
    if (incoming.providerCode && stored.providerCode && incoming.providerCode !== stored.providerCode) return false;
    const [location, saved] = [incoming.location.trim(), stored.location.trim()];
    return location === saved || (!saved && location !== '' && location === jetspeedPlace(incoming.description.trim()));
  },
};
