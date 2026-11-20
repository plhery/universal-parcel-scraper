import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Bob Go's checkpoint states, as its tracker's script names them. The courier
 * that carries the parcel reports in its own words; Bob Go files each report
 * under one of these states and keeps the courier's words as the message.
 */
export const BOB_GO_STATES: Readonly<Record<string, Stage>> = {
  pending: 'registered',
  'pending-payment': 'registered',
  'collection-unassigned': 'registered',
  'collection-assigned': 'registered',
  // The courier did not collect the parcel from the merchant.
  'collection-failed-attempt': 'exception',
  'failed-collection': 'exception',
  'collection-exception': 'exception',
  'collection-rejected': 'exception',
  collected: 'accepted',
  'in-transit': 'in_transit',
  'at-hub': 'in_transit',
  'at-destination-hub': 'in_transit',
  // Back at the courier's hub after a delivery round, to go out again or back to the merchant.
  'returned-to-hub': 'in_transit',
  'delivery-unassigned': 'in_transit',
  'delivery-assigned': 'in_transit',
  'out-for-delivery': 'out_for_delivery',
  'ready-for-pickup': 'ready_for_pickup',
  'in-locker': 'ready_for_pickup',
  delivered: 'delivered',
  // Taken from a pickup point or locker by the buyer.
  'buyer-collected': 'delivered',
  'delivery-failed-attempt': 'failed_attempt',
  'failed-delivery': 'failed_attempt',
  'failed-will-retry': 'failed_attempt',
  'failed-indefinitely': 'exception',
  'delivery-exception': 'exception',
  'delivery-rejected': 'exception',
  'returned-to-sender': 'returned',
  cancelled: 'exception',
  'cancelled-by-courier': 'exception',
  'cancelled-by-provider': 'exception',
};

/** States about the merchant's account or Bob Go's link to the courier, not the parcel. */
const SILENT: Readonly<Record<string, string>> = {
  'payment-failed': 'The merchant\'s payment for the label failed; the parcel keeps the stage it had.',
  'tracking-failed': 'Bob Go could not read the courier\'s tracking; the parcel keeps the stage it had.',
};

const STATES = new Map(Object.entries(BOB_GO_STATES));

/** The stage Bob Go's state gives, if the map knows it. */
export function bobGoMappedStage(state: string): Stage | undefined {
  return STATES.get(state);
}

/** A checkpoint's stage: its state, else the shared rules on its wording, else nothing. */
export function bobGoStage(state: string, wording: string): ClassifiedWording | null {
  const mapped = bobGoMappedStage(state);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (Object.hasOwn(SILENT, state)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? bobGoMappedStage(code) : undefined),
  gaps: Object.entries(SILENT).map(([code, note]) => ({ code, note })),
};
