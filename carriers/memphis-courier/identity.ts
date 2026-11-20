import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording, place and code. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim() && incoming.providerCode === stored.providerCode;
}

// The service's clocks can carry a fraction of a second, which rows stored without it lack: the
// same scan less than a minute away takes its row over.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'memphis-courier', storedSources: ['memphis-courier'], requireProviderCode: false, matchEachScan: true,
  matchWithinMinute: true, matches: sameScan,
};
