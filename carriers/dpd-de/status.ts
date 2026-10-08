import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { statusMap as dpd } from '../dpd/status.js';

/**
 * The German app's scans carry wording only. The shared classifier misreads several of these,
 * so each is mapped whole; a variable date is recorded as an ellipsis.
 */
export const DPD_DE_APP_SCANS: Readonly<Record<string, Stage>> = {
  'Order information has been transmitted to DPD.': 'registered',
  // The sender booked a collection, which has not happened yet.
  'Pickup ordered for: …': 'registered',
  'Pickup not possible No goods acceptance / goods pickup.': 'registered',
  'Parcel handed to DPD': 'accepted',
  'Parcel handed to Pickup parcelshop by consignor.': 'accepted',
  'In transit.': 'in_transit',
  'At parcel delivery centre.': 'in_transit',
  'Transfer to DPD Pickup station by DPD driver.': 'in_transit',
  'Out for delivery.': 'out_for_delivery',
  'Unfortunately we have not been able to deliver your parcel.': 'failed_attempt',
  'Back at parcel delivery centre after an unsuccessful delivery attempt.': 'failed_attempt',
  "We're sorry but your parcel couldn't be delivered as arranged.": 'exception',
  'Delivered by driver to DPD Pickup parcelshop/ station.': 'ready_for_pickup',
  // The recipient collected the parcel from a locker or a shop: delivered, as for UPS.
  'Picked up from DPD Pickup station by consignee.': 'delivered',
  'Picked up from Pickup parcelshop by consignee.': 'delivered',
  'Parcel has been left in: mail box': 'delivered',
  'Delivered.': 'delivered',
  // The return's own scans: under way it stays nonterminal, then it reaches the sender.
  'At parcel delivery centre. (Return to sender)': 'exception',
  'Delivered. (Return to sender)': 'returned',
};

/** The key a scan's wording is mapped under: a booked collection's date becomes an ellipsis. */
export const dpdDeScanKey = (wording: string) => wording.replace(/^(Pickup ordered for:) \d{2}\.\d{2}\.\d{4}$/i, '$1 …');

const NORMALIZED_SCANS = new Map(Object.entries(DPD_DE_APP_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/**
 * What the map says about one scan: the app's scans by their wording, the guest API's by DPD's
 * codes. The guest API's codes left unmapped on purpose stay so; the Swiss page's labels do not
 * apply, since German lookups never read that page.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? dpd.stage(code, wording) : NORMALIZED_SCANS.get(dpdDeScanKey(wording)),
  gaps: dpd.gaps.filter(gap => gap.code !== undefined),
};
