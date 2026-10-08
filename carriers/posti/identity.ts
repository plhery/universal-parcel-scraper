import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';

/**
 * Whether a scan's town is Posti's "ULKOMAILLA" ("abroad"), which it gives,
 * untranslated, to scans outside Finland. It names no place, and the public
 * reply carries no country to put in its stead.
 */
export function isPostiAbroadLabel(location: string): boolean {
  return location.replace(/\s+/g, ' ').trim().toLocaleUpperCase('fi-FI') === 'ULKOMAILLA';
}

// Scans stored with that label as their location lose it and keep their row.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'posti', storedSources: ['posti'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesDroppedLocation(incoming, stored, isPostiAbroadLabel),
};
