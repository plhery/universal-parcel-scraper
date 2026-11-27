import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { dpdAtMappedStage } from '../dpd-at/status.js';

const place = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('de-DE');

// The guest API's hand-over is the first depot's scan, which the app calls "In transit.":
// DPD's map leaves the hand-over unstaged, so its wording reads as accepted. The app reads
// that scan as accepted before anything moved the parcel, where DPD Austria's copy is on the way.
const handOver = (other: SameInstantScan, app: SameInstantScan) => app.description.replace(/\s+/g, ' ').trim().toLowerCase() === 'in transit.'
  && (other.providerCode === 'PARCEL_HANDED' || (app.stage === 'accepted' && other.stage === 'in_transit' && service(other) === 'austria'));

// The codes the guest API shares with myDPD's names for a scan's state.
const SHARED_CODES: ReadonlySet<string> = new Set(['DELIVERED', 'RETURN_TO_SENDER']);

// The service a scan came from: the app's carry no code, the guest API's DPD's code, and DPD Austria's,
// asked once the parcel is there, myDPD's name for their state (carriers/dpd-at).
function service({ providerCode }: SameInstantScan): 'app' | 'guest' | 'austria' {
  if (!providerCode) return 'app';
  return dpdAtMappedStage(providerCode) && !SHARED_CODES.has(providerCode.toUpperCase()) ? 'austria' : 'guest';
}

// The app service, the guest API and DPD Austria answer apart and date one scan
// to the minute or to the second, in their own wording. Only the guest API's
// unverified reply names no place. A scan from one service matches a stored scan
// from another at the same stage, or the hand-over in either's words, and at
// the same place, or where one of them names none.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const [location, saved] = [place(incoming.location), place(stored.location)];
  return incoming.stage !== ''
    && (incoming.stage === stored.stage || handOver(incoming, stored) || handOver(stored, incoming))
    && service(incoming) !== service(stored)
    && (location === saved || !location || !saved);
}

// A unit abroad's scans, which a release dates on that unit's clock rather than Germany's, keep their rows.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'dpd-de', storedSources: ['dpd-de'], requireProviderCode: false, matchEachScan: true, matches, matchWithinMinute: true,
  matchWallClock: true,
};
