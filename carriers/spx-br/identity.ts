import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { spxBrHubPlace, spxBrHubWording, spxBrPlacedText, spxBrPostedText, spxBrStageWording } from './parser.js';

// A scan stored with its centre, origin or port in its wording reads the same
// wording without it, at the same instant, with that place or the reply's own.
// A posting stored with its drop-off point's town reads the same wording without it.
// A delivery stored without who took the parcel reads the same wording with them.
// A fleet scan stored with a hub's code, in its place or its wording, reads it as that hub's place.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'spx-br', storedSources: ['spx-br'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, row) => {
    if (incoming.description === '' || incoming.providerCode !== row.providerCode) return false;
    const stored = { ...row, description: spxBrHubWording(row.description), location: spxBrHubPlace(row.location) };
    if (incoming.description === stored.description) return incoming.location === stored.location;
    if (incoming.location === stored.location && spxBrPostedText(stored.description) === incoming.description) return true;
    if (incoming.location === stored.location && spxBrStageWording(incoming.description) === stored.description) return true;
    const placed = spxBrPlacedText(stored.description);
    return placed.description === incoming.description
      && (incoming.location === stored.location || (stored.location === '' && incoming.location === placed.location));
  },
};
