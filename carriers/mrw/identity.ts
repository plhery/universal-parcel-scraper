import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('es-ES');

// MRW scans have no code. A hub scan stored before its bracketed label was
// read gains that label in place; its wording still names the same scan.
// MRW scans carry only a local time, and apps store only scans with an
// instant, so this matters only once a scan has one.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(wording) && wording === normalized(stored.description)
    && (location === savedLocation || (!savedLocation && / \([\p{L} ]+\)$/u.test(location)));
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'mrw', storedSources: ['mrw'], requireProviderCode: false, matchEachScan: true, matches,
};
