import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { chinaPostOffice } from './status.js';

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const wording = (scan: SameInstantScan) => normalized(scan.description);

/** One row, by its wording and place. Yuntrack's rows have no code. */
function sameRow(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim();
}

/** A China Post arrival or departure stored with its office in the wording, which is now its place. */
function sameOffice(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const scan = chinaPostOffice(stored.description);
  return scan !== undefined && normalized(scan.wording) === wording(incoming) && scan.office === incoming.location.trim();
}

// Earlier releases dated the rows without a place on China's leg on the
// destination's zone for Node lookups. Read on China's clock, a row shows the
// same wall clock under another offset and takes over the row stored from it.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'yunexpress', storedSources: ['yunexpress'], requireProviderCode: false,
  matchEachScan: true, matches: (incoming, stored) => sameRow(incoming, stored) || sameOffice(incoming, stored), matchWallClock: true,
};
