import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { dpdUkWording, withoutDriverName } from './wording.js';

const wording = (scan: SameInstantScan) => dpdUkWording(withoutDriverName(scan.description));

/** One scan, by its wording and place. DPD UK's scans have no code. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored) && incoming.location.trim() === stored.location.trim();
}

// The round's notice drops the hour it gave for the delivery once the round is over, and
// earlier releases kept the driver's name a scan gives. The scan keeps its row either way.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dpd-uk', storedSources: ['dpd-uk'], requireProviderCode: false, matchEachScan: true, matches: sameScan,
};
