import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// Total Express's wall clocks state no zone, so a scan a better deduced zone
// re-dates takes over its row by wall clock. A scan stored with a "DE" where
// its base goes keeps its row once worded without it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'total-express', storedSources: ['total-express'], requireProviderCode: false,
  matchEachScan: true, matchWallClock: true,
  matches: (incoming, stored) => sameScan(incoming, stored)
    || sameScan(incoming, { ...stored, description: stored.description.trim().replace(/\s+DE$/i, '') }),
};
