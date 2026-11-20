import type { SameInstantIdentityPolicy, SameInstantScan } from '../../core/catalog/eventIdentity.js';
import { countryTimeZone } from '../../core/time/index.js';

/** A location without the "Office - " the adapter once kept before an office's name or code. */
function named(text: string): string {
  return text.trim().replace(/^Office - /, '');
}

/**
 * What a stored location reads as now. The adapter once kept an office of exchange's UPU
 * code ("Office - DEFRAA", "INMAAB 600099"), which it now leaves out with the PIN unless the
 * office is in India. It tells a code from an office's name of five or six letters ("KANPUR",
 * "RODGAU") by the airport after the country, which a browser does not load, so a stored
 * word with a country's two letters first is read both ways.
 */
function storedReadings(text: string): string[] {
  const location = named(text);
  const code = /^([A-Z]{2})[A-Z]{3}[A-Z\d]?(?: (\d{6}))?$/.exec(location);
  if (!code || !countryTimeZone(code[1])) return [location];
  return [location, code[1] === 'IN' ? code[2] ?? '' : ''];
}

// MySpeedPost rewords a scan, and can restate it under another event_type, at the same
// second and office: "Item bagged" (ItemBagged) as "Bag Closed" (BagOpened), "Item
// Dispatched" as "Bag Dispatched". A reply never holds two scans at one second and office,
// so the scan at that second and office, the only one both ways, is the stored one.
// Scans abroad were read on India's clock until October 2026 and now show the
// destination's offset, unless a reply lacks what places them abroad. A bag's
// arrival comes coded (MailArrived) in one reply and in prose ("Bag unloaded at
// destination Airport") in another, placed only by a flight remark the prose can
// lack: at one second, one of each is one arrival, placed or not.
const ARRIVAL_FORMS = ['MailArrived', 'BagUnloaded'].sort().join();
const arrivalForms = (incoming: SameInstantScan, stored: SameInstantScan) =>
  [incoming.providerCode, stored.providerCode].sort().join() === ARRIVAL_FORMS;

export const sameInstantIdentityPolicy: SameInstantIdentityPolicy = {
  sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: false, matchEachScan: true,
  matches: (incoming, stored) => storedReadings(stored.location).includes(named(incoming.location))
    || (arrivalForms(incoming, stored) && (!incoming.location.trim() || !stored.location.trim())),
  relabelledFrom: 'Asia/Kolkata',
};
