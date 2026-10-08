import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { cainiaoActionCode, cainiaoActionStage } from './status.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// A scan stored while its town was still part of the wording, "[Bordeaux] Out for
// delivery" without a location, is the same scan as "Out for delivery" in Bordeaux.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'aliexpress', storedSources: ['aliexpress'], requireProviderCode: false,
  matchEachScan: true,
  matches(incoming, stored) {
    const wording = normalized(incoming.description);
    const location = normalized(incoming.location);
    const movedLocation = Boolean(location) && !normalized(stored.location)
      && normalized(stored.description) === `[${location}] ${wording}`;
    if (!wording || ['', 'unknown'].includes(incoming.stage)) return false;
    if (incoming.stage === stored.stage) return movedLocation;

    // Correct only the old adapter's coarse stages, with the same action,
    // wording and place. The consumer also requires a unique same-time match.
    const code = cainiaoActionCode(incoming.providerCode);
    if (!code || code !== cainiaoActionCode(stored.providerCode)
      || incoming.stage !== cainiaoActionStage(code)) return false;
    const correction = (['customs', 'accepted'].includes(incoming.stage) && stored.stage === 'in_transit')
      || (incoming.stage === 'ready_for_pickup' && stored.stage === 'out_for_delivery')
      || (incoming.stage === 'out_for_delivery' && stored.stage === 'ready_for_pickup');
    return correction && (movedLocation || (wording === normalized(stored.description)
      && location === normalized(stored.location)));
  },
};
