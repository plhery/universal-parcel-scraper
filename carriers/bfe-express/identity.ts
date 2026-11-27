import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { bfeWording } from './status.js';

// A row stored whole, its place still at its head ("AR, En camino"), before the map knew its wording keeps its row once
// the adapter shows it without that place and with the place as its location.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'bfe-express', storedSources: ['bfe-express'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => {
    if (stored.location.trim()) return false;
    const reread = bfeWording(stored.description.trim());
    return reread.location !== undefined && reread.description === incoming.description.trim() && reread.location === incoming.location.trim();
  },
};
