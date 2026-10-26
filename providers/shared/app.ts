import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment, matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { chinaPostEnglish, chinaPostLabelPlace } from '../../carriers/china-post/status.js';
import { place } from './result.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/**
 * A China Post label stored in Chinese before 17TRACK's copy showed its
 * English: the English of the stored label, at the location stored or as
 * the provider now reads it, or at the name the label gave in 【】 where none
 * was stored, with provider codes that agree.
 */
function matchesChinaPostEnglish(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const english = chinaPostEnglish(stored.description);
  const location = normalized(incoming.location);
  const named = stored.location.trim() ? '' : place(chinaPostLabelPlace(stored.description) ?? '');
  return english !== undefined && normalized(english) === normalized(incoming.description)
    && (location === normalized(stored.location) || location === normalized(place(stored.location)) || (named !== '' && location === normalized(named)))
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// A copy may add a place, or drop a label it was once stored with that names
// no place (Posti's "abroad", a feed's system user) or the words before a
// depot's town, or show a China Post label in English.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'unknown', storedSources: ['unknown'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored)
    || matchesRereadLocation(incoming, stored, place) || matchesChinaPostEnglish(incoming, stored),
};
