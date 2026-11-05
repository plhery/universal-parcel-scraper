import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

// MySpeedPost rewords a scan, and can restate it under another event_type, at the same
// second and office: "Item bagged" (ItemBagged) as "Bag Closed" (BagOpened), "Item
// Dispatched" as "Bag Dispatched". A reply never holds two scans at one second and office,
// so the scan at that second and office, the only one both ways, is the stored one.
// Scans abroad were read on India's clock until October 2026 and now show the
// destination's offset, unless a reply lacks what places them abroad.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => incoming.location.trim() === stored.location.trim(),
  relabelledFrom: 'Asia/Kolkata',
};
