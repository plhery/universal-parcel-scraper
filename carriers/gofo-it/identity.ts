import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { isGofoItalyHubCode } from '../gofo-fr/parser.js';

// A scan stored with a hub's code as its location loses it and keeps its row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'gofo-it', storedSources: ['gofo-it'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isGofoItalyHubCode),
};
