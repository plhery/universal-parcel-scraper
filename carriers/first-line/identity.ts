import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { firstLinePlace } from './place.js';

// A row stored with GOFO's town and state said twice is taken over by the scan that names them once.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'first-line', storedSources: ['first-line'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => matchesRereadLocation(incoming, stored, firstLinePlace),
};
