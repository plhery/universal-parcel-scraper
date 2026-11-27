import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation, matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { bpostPlaceName, bpostStoredPlace } from './parser.js';

// Scans stored with a name that is no place as their location ("LCI", "PSM IN PARCELS") lose it and keep their row,
// and so do scans stored at a partner's office with its country code added ("PTLISL Portugal PT, PT", now "PTLISL, Portugal").
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'bpost', storedSources: ['bpost'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, (location) => bpostPlaceName(location) === '')
    || matchesRereadLocation(incoming, stored, bpostStoredPlace),
};
