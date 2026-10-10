import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('it-IT');

// Poste scans have no code. A depot scan stored before its town and province
// were read gains them in place; its wording still names the same scan.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const location = normalized(incoming.location);
  const savedLocation = normalized(stored.location);
  return Boolean(wording) && wording === normalized(stored.description)
    && (location === savedLocation || (!savedLocation && / \([A-Z]{2}\)$/.test(location)));
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'poste-italiane', storedSources: ['poste-italiane'], requireProviderCode: false, matchEachScan: true, matches,
};
