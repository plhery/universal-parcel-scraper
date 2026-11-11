import type { SameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';

/**
 * A location as the adapter writes it now. It once kept "Office - " before an
 * office India Post names, and before an office of exchange's UPU code, which
 * it now leaves out with the PIN unless the office is in India.
 */
function location(text: string): string {
  const stored = /^Office - (.+)$/.exec(text.trim());
  if (!stored) return text.trim();
  const code = /^([A-Z]{2})[A-Z]{3}[A-Z\d](?: (\d{6}))?$/.exec(stored[1]!);
  if (!code) return stored[1]!;
  return code[1] === 'IN' ? code[2] ?? '' : '';
}

// MySpeedPost rewords a scan, and can restate it under another event_type, at the same
// second and office: "Item bagged" (ItemBagged) as "Bag Closed" (BagOpened), "Item
// Dispatched" as "Bag Dispatched". A reply never holds two scans at one second and office,
// so the scan at that second and office, the only one both ways, is the stored one.
// Scans abroad were read on India's clock until October 2026 and now show the
// destination's offset, unless a reply lacks what places them abroad.
export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => location(incoming.location) === location(stored.location),
  relabelledFrom: 'Asia/Kolkata',
};
