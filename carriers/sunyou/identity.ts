import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// Scans stored before SunYou's event codes were kept have none, and their
// stage came from their wording or from nothing. They take the code and its
// stage in place when the wording and place are unchanged; a different code
// is a different scan.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  return wording !== '' && Boolean(incoming.providerCode)
    && (!stored.providerCode || stored.providerCode === incoming.providerCode)
    && wording === normalized(stored.description)
    && normalized(incoming.location) === normalized(stored.location);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'sunyou', storedSources: ['sunyou'], requireProviderCode: false,
  matchEachScan: true, matches,
};
