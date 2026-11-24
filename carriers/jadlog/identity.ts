import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { API_LABELS } from '../dpd/status.js';

const wording = (scan: SameInstantScan) => scan.description.replace(/\s+/g, ' ').trim().toLowerCase();

/** One scan read twice: the same wording and place, and codes that agree when both carry one. */
function sameScan(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  return wording(incoming) !== '' && wording(incoming) === wording(stored)
    && incoming.location.trim() === stored.location.trim()
    && (!incoming.providerCode || !stored.providerCode || incoming.providerCode === stored.providerCode);
}

/**
 * One scan in Jadlog's tracker and in the answer of the DPD group's guest service: the tracker dates it to
 * the minute in Portuguese, the service to the second under DPD's code, both without a place.
 */
function groupCopy(site: SameInstantScan, group: SameInstantScan): boolean {
  return !site.providerCode && Object.hasOwn(API_LABELS, group.providerCode) && !site.location.trim() && !group.location.trim()
    && site.stage !== '' && site.stage === group.stage;
}

/**
 * Jadlog's lookups read its tracker and, when it does not answer, the group's guest service. A scan from
 * one and the other's copy of it, less than a minute apart with the same stage, are one.
 */
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'jadlog', storedSources: ['jadlog'], requireProviderCode: false, matchEachScan: true, matchWithinMinute: true,
  matches: (incoming, stored) => sameScan(incoming, stored) || groupCopy(incoming, stored) || groupCopy(stored, incoming),
};
