import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { scanWording, withoutDeliveryPlace } from './wording.js';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

// Scans stored before JD Logistics' operation codes were kept have none, and
// their stage came from their wording or from nothing. They take the code and
// its stage in place when the place is unchanged and the wording is too, once
// the courier's contact, the partner's number or the place a delivery was handed
// to that a stored row may still hold is dropped from it. A different code is a
// different scan. A domestic scan stored under its code with the wording an
// earlier release cut at a contact word inside its status phrase ("已与",
// "您的快件将由", "…请您准备签收（") is the start of its wording now.
function matches(incoming: SameInstantScan, stored: SameInstantScan): boolean {
  const wording = normalized(incoming.description);
  if (wording === '' || !incoming.providerCode || (stored.providerCode && stored.providerCode !== incoming.providerCode)
    || normalized(incoming.location) !== normalized(stored.location)) return false;
  const earlier = normalized(withoutDeliveryPlace(scanWording(stored.description))).replace(/[（(【]+$/u, '');
  return wording === earlier || (earlier !== '' && stored.providerCode === incoming.providerCode && wording.startsWith(earlier));
}

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'jd-logistics', storedSources: ['jd-logistics'], requireProviderCode: false,
  matchEachScan: true, matches,
};
