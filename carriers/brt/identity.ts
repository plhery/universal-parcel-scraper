import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { matchesDroppedLocation } from '../../core/catalog/locationIdentity.js';
import { API_LABELS } from '../dpd/status.js';
import { isBrtCarrierDepot } from './depot.js';
import { brtEnglishLabel } from './status.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/** One scan labelled on BRT's Italian page and on its English one, at the same place. */
function translated(italian: SameInstantScan, english: SameInstantScan): boolean {
  return brtEnglishLabel(italian.description)?.toLowerCase() === wording(english)
    && italian.location.trim() === english.location.trim() && !italian.providerCode && !english.providerCode;
}

/**
 * One scan on BRT's page and in the answer of the DPD group's guest service, which stands in while BRT's
 * tracker is down: the page dates it to the minute at its depot, the service to the second under DPD's
 * code, in its own words and without a place.
 */
function groupCopy(page: SameInstantScan, group: SameInstantScan): boolean {
  return !page.providerCode && Object.hasOwn(API_LABELS, group.providerCode) && !group.location.trim()
    && page.stage !== '' && page.stage === group.stage;
}

/**
 * A scan stored at a depot named by carriers alone loses that place and keeps
 * its row. BRT's collection there, stored as the acceptance, is now its
 * hand-over from the partner, in transit. A scan labelled in Italian takes
 * over the row stored with its English label, and the reverse. A scan from
 * BRT's page and the DPD group's copy of it, less than a minute apart, are one.
 */
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'brt', storedSources: ['brt'], requireProviderCode: false, matchEachScan: true, matchWithinMinute: true,
  matches: (incoming, stored) => sameScan(incoming, stored) || translated(incoming, stored) || translated(stored, incoming)
    || groupCopy(incoming, stored) || groupCopy(stored, incoming)
    || matchesDroppedLocation(incoming,
      stored.stage === 'accepted' && incoming.stage === 'in_transit' ? { ...stored, stage: 'in_transit' } : stored, isBrtCarrierDepot),
};
