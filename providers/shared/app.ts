import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesLocationEnrichment, matchesRereadLocation } from '../../core/catalog/locationIdentity.js';
import { chinaPostEnglish, chinaPostLabelPlace } from '../../carriers/china-post/status.js';
import { ytoRelayedWording } from '../../carriers/yto/wording.js';
import { withoutCarrierNote } from '../../carriers/aliexpress/status.js';
import { chronopostOfficeLabel } from '../seventeentrack/chronopost.js';
import { place, trailingPlace } from './result.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/**
 * A China Post label stored in Chinese before 17TRACK's copy showed its
 * English: the English of the stored label, at the location stored or as
 * the provider now reads it, or at the name the label gave in 【】 where that
 * reads as none, with provider codes that agree.
 */
function matchesChinaPostEnglish(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const english = chinaPostEnglish(stored.description);
  const location = normalized(incoming.location);
  const named = place(stored.location) ? '' : place(chinaPostLabelPlace(stored.description) ?? '');
  return english !== undefined && normalized(english) === normalized(incoming.description)
    && (location === normalized(stored.location) || location === normalized(place(stored.location)) || (named !== '' && location === normalized(named)))
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * A scan stored without a location, its place in brackets after the wording,
 * before 17TRACK's copy took that place for the location: the same wording
 * at that place, with provider codes that agree.
 */
function matchesTrailingPlace(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const trailing = stored.location.trim() ? undefined : trailingPlace(stored.description);
  return trailing !== undefined && normalized(trailing.wording) === normalized(incoming.description)
    && normalized(trailing.place) === normalized(incoming.location)
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * A YTO scan stored with the courier's name and phone or YTO's hotline, before
 * 17TRACK's copy left them out: the stored wording without them, at the same
 * location, with provider codes that agree.
 */
function matchesYtoContacts(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = ytoRelayedWording(stored.description);
  return wording !== '' && normalized(wording) !== normalized(stored.description) && normalized(wording) === normalized(incoming.description)
    && normalized(incoming.location) === normalized(stored.location)
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * A Cainiao step stored with the carrier's note after its wording, before the providers' copies left the
 * note out: the stored step without it, at the same location, with provider codes that agree.
 */
function matchesCarrierNote(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = withoutCarrierNote(stored.description);
  return wording !== stored.description && normalized(wording) === normalized(incoming.description)
    && normalized(incoming.location) === normalized(stored.location)
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * A Chronopost scan stored as 17TRACK writes it, its office and label as the location or ahead of
 * the description, before 17TRACK's copy kept the label at the office (`chronopostOfficeLabel`):
 * the same label at the same office, with provider codes that agree.
 */
function matchesChronopostOffice(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const read = chronopostOfficeLabel(stored.location.trim(), stored.description.trim());
  return read !== null && normalized(read.description) === normalized(incoming.description)
    && normalized(read.location) === normalized(incoming.location)
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * A delivery stored as a bare "Delivered", before the providers kept the
 * carrier's own wording and a place naming a door or a signatory: a delivery
 * in any words, at the location stored or where none was, with provider codes
 * that agree.
 */
function matchesBareDelivery(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return incoming.stage === 'delivered' && stored.stage === 'delivered' && normalized(stored.description) === 'delivered'
    && (!stored.location.trim() || normalized(incoming.location) === normalized(stored.location))
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

// A copy may add a place, or drop a label it was once stored with that names
// no place (Posti's "abroad", a feed's system user) or the words before a
// depot's town, show a China Post label in English, or take the place from
// after its wording, or leave out a YTO courier's contact or a Cainiao carrier's
// note. A delivery stored as a bare "Delivered" takes the carrier's own words.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'unknown', storedSources: ['unknown'], requireProviderCode: false,
  matchEachScan: true,
  matches: (incoming, stored) => matchesLocationEnrichment(incoming, stored)
    || matchesRereadLocation(incoming, stored, place) || matchesChinaPostEnglish(incoming, stored)
    || matchesTrailingPlace(incoming, stored) || matchesYtoContacts(incoming, stored) || matchesCarrierNote(incoming, stored)
    || matchesBareDelivery(incoming, stored) || matchesChronopostOffice(incoming, stored),
};
