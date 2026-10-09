import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English tracking page's scan wording, mapped whole. The shared
 * classifier misreads several of these, such as a parcel dispatched for
 * delivery or waiting at a pickup point.
 */
export const DPD_PL_SCANS: Readonly<Record<string, Stage>> = {
  'Registered parcel data, parcel not dispatched yet': 'registered',
  'Parcel dropped-off in pickup point': 'accepted',
  'Parcel received by DPD depot': 'in_transit',
  'Sent outside Poland': 'in_transit',
  // A short hold at a depot, seen before a pickup point run.
  'Parcel stored in depot': 'in_transit',
  'Parcel dispatched to be collected by pickup point': 'in_transit',
  'Parcel dispatched to be delivered': 'out_for_delivery',
  // The pickup point or locker received the parcel for the recipient.
  'Parcel collected by pickup point': 'ready_for_pickup',
  'The Parcel has been placed in the DPD Pickup Station': 'ready_for_pickup',
  'To be collected personally': 'ready_for_pickup',
  'Parcel not delivered - recipient not available': 'failed_attempt',
  'Parcel not delivered - wrong address': 'failed_attempt',
  'Not delivered to pickup point - overloaded': 'failed_attempt',
  // A refusal, a parcel nobody collected in time, and a return sent back
  // under a new parcel number: delivery stops, and none has reached the sender.
  'Parcel not delivered - recipient resigned': 'exception',
  'Waiting for pickup timeout': 'exception',
  'Parcel return': 'exception',
  'Parcel delivered': 'delivered',
};

// A courier's collection accepts the parcel from its sender. After an earlier
// acceptance or depot scan, as from the pickup point the sender dropped it at
// or from another country's network, it hands the parcel on.
const COLLECTIONS = ['Parcel collected by courier', 'Parcel collected'];

// Messages to the recipient: no movement, so the parcel keeps its stage.
const NOTICES = ['Mail notification', 'SMS notification', 'Sent notification'];

const SCANS = new Map(Object.entries(DPD_PL_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const COLLECTION_KEYS = new Set(COLLECTIONS.map(normalizeStatusWording));
const NOTICE_KEYS = new Set(NOTICES.map(normalizeStatusWording));

/** The stage the wording alone gives a scan, if any. */
export function dpdPlScanStage(wording: string): Stage | undefined {
  return SCANS.get(normalizeStatusWording(wording));
}

/** A courier's collection, whose stage depends on the scans before it. */
export function isDpdPlCollection(wording: string): boolean {
  return COLLECTION_KEYS.has(normalizeStatusWording(wording));
}

export function isDpdPlNotice(wording: string): boolean {
  return NOTICE_KEYS.has(normalizeStatusWording(wording));
}

/**
 * What the map says about one scan. The page's scans carry wording only. A
 * collection's stage depends on the scans before it, so the map does not know
 * it from its wording; notices are left without a stage on purpose.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : SCANS.get(wording),
  gaps: [...NOTICE_KEYS].map(wording => ({
    wording, note: 'A message to the recipient, not a movement: the parcel keeps the stage it had.',
  })),
};
