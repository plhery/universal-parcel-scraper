import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { osmCodeStage } from '../osm-worldwide/status.js';

/**
 * ePost Global's English wording. Its rows carry a code, but rows it relays
 * from the partner that delivers the parcel keep the partner's code, so a code
 * alone names no scan: PostNL's 30 is ePost Global's 30. The map reads the
 * wording: ePost Global's own, then the partners' seen on its parcels. Other
 * partner wording goes to the shared wording rules.
 * OSM Worldwide's codes name it ("OSM04"), so its rows read as OSM's own do.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['data received', 'registered'],
  // Stamped a minute after the data, every time: the label, not a scan.
  ['shipment in transit to the epost global processing center', 'registered'],
  ['parcel received and processing', 'accepted'],
  ['parcel shipped', 'in_transit'],
  // The handover a minute after shipping, without the service it goes to.
  ['in transit', 'in_transit'],
  // DAI Post, for New Zealand: its manifest, then its origin hub and the airline.
  ['customer information manifested', 'registered'],
  ['checked in at origin hub', 'in_transit'],
  ['airline delay', 'in_transit'],
  ['collected from the airline for processing', 'in_transit'],
  // ECMS Express: its export warehouse at the origin, after ePost Global shipped the parcel.
  ['parcel has arrived at export distribution warehouse', 'in_transit'],
  // PostNL, through Spring. Its acceptance comes after ePost Global shipped the parcel.
  ['consignment received at the postnl acceptance centre', 'accepted'],
  ['the item has been manifested and ready to transport', 'in_transit'],
  ['the item is tied to a mawb and ready for shipment', 'in_transit'],
  // La Poste's wording for parcels PostNL brings to France, after they left the United States.
  ['your item has been dropped off by the sender with our postal partner in the country of origin.', 'in_transit'],
  ['your item is ready to be forwarded from its foreign territory. it will be given to the carrier for forwarding.', 'in_transit'],
  // GLS's European network, after the hand-over: a parcel center's arrival and departure.
  ['the parcel has reached the parcel center.', 'in_transit'],
  ['the parcel has left the parcel center.', 'in_transit'],
  // Royal Mail's British partner, after the hand-over: its hub, depots and the collection point. Its codes are
  // Intersoft's Intelligent Shipper buckets, which file "Arrived in customs" as misrouted (ISMI).
  ['departed hub', 'in_transit'],
  ['shipment received in depot', 'in_transit'],
  ['arrived in customs', 'customs'],
  ['shipment departed depot', 'in_transit'],
  ['ready for collection', 'ready_for_pickup'],
]);

// The handover a minute after shipping: "In transit to {service} tracking #: {number}".
const HANDED_OVER = /^in transit (?:to|via) \S.* tracking ?#:/;
// A row relayed from OSM Worldwide, under its code.
const OSM_CODE = /^OSM\d{2}$/;

// ePost Global's own rows: its data, label, processing centers and handover. Every other row is a partner's.
const OWN = new Set(['data received', 'shipment in transit to the epost global processing center', 'parcel received and processing',
  'parcel shipped', 'in transit']);

// The rows ePost Global's processing centers scan, stamped on the center's clock.
const FACILITY_SCANS = new Set(['parcel received and processing', 'parcel shipped']);

/** The stage the map gives a row relayed from OSM Worldwide by its code, else the wording, if it knows it. */
export function epostGlobalScanStage(wording: string, code = ''): Stage | undefined {
  const relayed = OSM_CODE.test(code) ? osmCodeStage(code) : undefined;
  if (relayed) return relayed;
  const normalized = normalizeStatusWording(wording);
  return HANDED_OVER.test(normalized) ? 'in_transit' : STAGES.get(normalized);
}

/** A row ePost Global writes itself, not one it relays from the partner. */
export function epostGlobalOwnRow(wording: string): boolean {
  const normalized = normalizeStatusWording(wording);
  return OWN.has(normalized) || HANDED_OVER.test(normalized);
}

/** GLS's European network's clock: its tracking runs on Central European time wherever the depot is. */
export const EPOST_GLOBAL_GLS_ZONE = 'Europe/Berlin';
/** The clock of Royal Mail's British partner, whose feed dates its rows to the minute in no zone. */
export const EPOST_GLOBAL_ROYAL_MAIL_ZONE = 'Europe/London';

// The handover to GLS's European network: "In transit to GLSEU tracking #: …".
const GLS_HANDED_OVER = /^in transit (?:to|via) gls ?eu(?:rope)? tracking ?#:/;
// The handover to a Royal Mail service: "In transit to ROYALMAIL 48 TRACKED tracking #: …", "… to RM48 DDP …".
const ROYAL_MAIL_HANDED_OVER = /^in transit (?:to|via) (?:royal ?mail|rm ?\d{2})\b.* tracking ?#:/;

/**
 * How a universal provider's copy of ePost Global's feed reads a row's clock: undefined for a
 * processing center's scan, which its place dates, or a feed that is not ePost Global's (it has
 * neither the label nor a handover); the partner's zone for a partner's row once ePost Global
 * handed the parcel to GLS's European network or to Royal Mail; null, a wall clock, for any other
 * row, as ePost Global's own tracker keeps it. Its relays of USPS's rows came two hours after
 * USPS's own scans when read on the facility's clock.
 */
export function epostGlobalCopyZone(wording: string, feed: readonly string[]): string | null | undefined {
  const rows = feed.map(normalizeStatusWording);
  if (!rows.some((row) => row === 'shipment in transit to the epost global processing center' || HANDED_OVER.test(row))) return undefined;
  if (epostGlobalOwnRow(wording)) return epostGlobalFacilityScan(wording) ? undefined : null;
  if (rows.some((row) => GLS_HANDED_OVER.test(row))) return EPOST_GLOBAL_GLS_ZONE;
  return rows.some((row) => ROYAL_MAIL_HANDED_OVER.test(row)) ? EPOST_GLOBAL_ROYAL_MAIL_ZONE : null;
}

/** A scan at one of ePost Global's processing centers. */
export function epostGlobalFacilityScan(wording: string): boolean {
  return FACILITY_SCANS.has(normalizeStatusWording(wording));
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function epostGlobalStage(wording: string, code = ''): ClassifiedWording | null {
  const mapped = epostGlobalScanStage(wording, code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Codes are shared with the partners' own, so only OSM Worldwide's and the wording are read. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => epostGlobalScanStage(wording, code ?? ''),
  gaps: [],
};
