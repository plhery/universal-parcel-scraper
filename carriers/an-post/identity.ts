import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// An Post's wall clocks state no zone abroad, so a scan a better deduced zone
// re-dates takes over its row by wall clock. A scan stored without a place and
// with an "in" where its place goes keeps its row once worded without it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'an-post', storedSources: ['an-post'], requireProviderCode: false,
  matchEachScan: true, matchWallClock: true,
  matches: (incoming, stored) => sameScan(incoming, stored)
    || (!stored.location.trim() && sameScan(incoming, { ...stored, description: stored.description.trim().replace(/\s+in$/, '') })),
};
