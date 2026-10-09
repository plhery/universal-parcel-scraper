/**
 * UPS status vocabulary.
 *
 * Every scan in UPS's `GetStatus` reply carries a two-character `actCode`. The
 * code is the stable key: one wording can stand for two codes ("Arrived at
 * Facility" is both the origin scan `OR` and an arrival `AR`), and the wording
 * arrives HTML-escaped and reworded. The adapter maps the code to a stage and
 * leaves a scan with an unmapped code to the shared wording classifier.
 *
 * The shipment detail also carries `progressBarType`, a coarse token, and
 * English prose. They decide the status only when the newest scan's code is
 * unmapped, and for the rendered page, which has no scans.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const EXCEPTION_TERMS = [
  'return to sender', 'returned', 'delivery attempted', 'we missed you',
  'not delivered', 'exception', 'action required',
];
const DELIVERED_TERMS = ['delivered', 'left at'];
const IN_TRANSIT_TERMS = [
  'on the way', 'in transit', 'we have your package', 'first ups possession',
  'departed', 'arrived', 'processing at ups facility',
];
const PENDING_TERMS = ['label created', 'manifest upload', 'shipment ready for ups'];

/**
 * Classify UPS status prose. `hasEvents` reports that the shipment already has
 * a scan history, which is what makes unrecognized wording "moving" rather
 * than "unknown"; without it an unmapped phrase stays `unknown` on purpose.
 */
export function upsStatus(text: string, hasEvents = false): CarrierStatus {
  const value = text.toLocaleLowerCase('en-US');
  if (EXCEPTION_TERMS.some((term) => value.includes(term))) return 'exception';
  if (DELIVERED_TERMS.some((term) => value.includes(term))) return 'delivered';
  if (value.includes('out for delivery')) return 'out_for_delivery';
  if (hasEvents || IN_TRANSIT_TERMS.some((term) => value.includes(term))) return 'in_transit';
  if (PENDING_TERMS.some((term) => value.includes(term))) return 'pending';
  return 'unknown';
}

/**
 * `progressBarType` on a shipment detail, lowercased. It outranks the prose
 * because it is the value the page's own progress bar is driven by.
 */
export const UPS_PROGRESS_STATUS: Readonly<Record<string, CarrierStatus>> = {
  manifestupload: 'pending',
  firstupspossession: 'in_transit',
  intransit: 'in_transit',
  outfordelivery: 'out_for_delivery',
  delivered: 'delivered',
  exception: 'exception',
};

/**
 * `actCode` on each scan, as seen live. A delay or a delivery instruction keeps
 * the parcel in transit; an unlisted code is left to the wording classifier.
 */
const ACTIVITY_STAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // Shipper created a label; UPS does not have the parcel yet.
  ['MP', 'registered'],
  // Drop-off at an access point, the access point readying it for UPS, a
  // pickup scan, and the origin scan.
  ['XD', 'accepted'], ['ZO', 'accepted'], ['PU', 'accepted'], ['OR', 'accepted'],
  // Facility scans, export and import scans.
  ['AR', 'in_transit'], ['DP', 'in_transit'], ['DS', 'in_transit'], ['YP', 'in_transit'],
  ['EP', 'in_transit'], ['IP', 'in_transit'],
  // Delays and new delivery plans: a late flight, a possible delay, a new
  // plan, a delivery a day early.
  ['18', 'in_transit'], ['Q5', 'in_transit'], ['E3', 'in_transit'], ['2U', 'in_transit'],
  // Address corrections, redirects and receiver requests, including a
  // delivery to an access point that is still pending or only confirmed.
  ['AL', 'in_transit'], ['HM', 'in_transit'], ['H6', 'in_transit'], ['TB', 'in_transit'],
  ['ZA', 'in_transit'], ['ZB', 'in_transit'], ['ZC', 'in_transit'],
  // Ground Saver's hand-off to the post office: moving there, transferred, and
  // received by it.
  ['ZW', 'in_transit'], ['LX', 'in_transit'], ['YH', 'in_transit'],
  // Collected back from an access point, or moved off one that is closing.
  ['3P', 'in_transit'], ['6B', 'in_transit'],
  // Loaded on the delivery vehicle, and out for delivery.
  ['OF', 'out_for_delivery'], ['OT', 'out_for_delivery'],
  // Receiver absent, business closed, or diverted to an access point after a
  // failed attempt.
  ['48', 'failed_attempt'], ['G3', 'failed_attempt'], ['5R', 'failed_attempt'],
  // Delivered to an access point, and held there.
  ['2Q', 'ready_for_pickup'], ['ZP', 'ready_for_pickup'],
  // Delivered, including collection from an access point and delivery by the
  // post office after a hand-off.
  ['9E', 'delivered'], ['FS', 'delivered'], ['KB', 'delivered'], ['KE', 'delivered'],
  ['2W', 'delivered'], ['YC', 'delivered'],
]);

/** The stage a scan's `actCode` stands for, or undefined when the code is not mapped. */
export function upsActivityStage(code: string): Stage | undefined {
  return ACTIVITY_STAGES.get(code.trim().toUpperCase());
}

/**
 * The milestone the rendered page's banner names, the only wording the
 * adapter reads without an activity code. Scan wording without its code is
 * not read: "Arrived at Facility" is both the origin scan and an arrival.
 */
const BANNER_STAGES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['label created', 'registered'],
  ['on the way', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage of the rendered page's banner, or undefined for a milestone it does not name. */
export function upsBannerStage(text: string): Stage | undefined {
  return BANNER_STAGES.get(normalizeStatusWording(text));
}

/** What the map says about one scan: by its activity code, or as the banner without one. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? upsActivityStage(code) : upsBannerStage(wording)),
  gaps: [],
};
