import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { classifyCorreosExpressStatus } from './status.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('es-ES');
// The neutral wording a scan with an unrecognized label is stored under.
const NEUTRAL = 'TRACKING UPDATE';

// A scan stored under the neutral wording before its label was recognized
// takes its label and stage in place; the town still names the same scan.
// Correos Express scans carry only a local time, and apps store only scans
// with an instant, so this matters only once a scan has one.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const location = normalized(incoming.location);
  if (location !== normalized(stored.location)) return false;
  const wording = normalized(incoming.description);
  return Boolean(wording) && (wording === normalized(stored.description)
    || (normalized(stored.description) === NEUTRAL && classifyCorreosExpressStatus(incoming.description) !== undefined));
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'correos-express', storedSources: ['correos-express'], requireProviderCode: false,
  matchEachScan: true, matches,
};
