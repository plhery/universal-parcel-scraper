import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { withoutRoutingPrefix } from './wording.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// A hand-off line stored with a USPS routing barcode, which opens with the
// recipient's ZIP code, takes the wording without it in place. Only that trim
// is matched: the instant, the place and the rest of the wording are unchanged.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  const trimmed = withoutRoutingPrefix(stored.description);
  return wording !== '' && trimmed !== stored.description && wording === normalized(trimmed)
    && normalized(incoming.location) === normalized(stored.location);
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'speedpak', storedSources: ['speedpak'], requireProviderCode: false,
  matchEachScan: true, matches,
};
