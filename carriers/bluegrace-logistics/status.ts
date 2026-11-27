import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The X12 214 status codes BlueGrace relays from the carriers it books.
 * Another code falls to the shared wording rules. En route to the delivery
 * location (X6) is staged by the parser, which reads the row's state as the
 * tracking page does.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['XB', 'registered'], // Shipment acknowledged: the carrier accepted the tender.
  ['X3', 'registered'], // The driver is at the pickup location; the freight is not on board yet.
  ['AF', 'accepted'], // Actual pickup.
  ['X4', 'in_transit'], // Arrived at a terminal.
  ['P1', 'in_transit'], // Departed a terminal.
  ['AV', 'in_transit'], // Available for delivery at the delivering terminal, before a delivery is booked.
  ['X9', 'in_transit'], // A delivery appointment is booked.
  // Handed to a connecting carrier. The shared rules would read "delivered" in its wording.
  ['J1', 'in_transit'],
  ['SD', 'exception'], // Shipment delayed, with the late reason.
  ['AJ', 'out_for_delivery'], // Tendered for delivery.
  ['X1', 'out_for_delivery'], // The truck is at the delivery location.
  ['D1', 'delivered'], // Completed unloading at the delivery location.
]);

/** The rows that date a forecast, which the parser keeps out of the history. */
const FORECASTS = [
  { code: 'AG', note: 'Estimated delivery: the forecast date of the delivery, kept as the estimate rather than as a scan.' },
  { code: 'AB', note: 'Delivery appointment date and time: the booked slot, kept as the estimate rather than as a scan.' },
];

/** The stage BlueGrace's map gives an X12 214 status code. */
export function bluegraceMappedStage(code: string | null): Stage | undefined {
  return code ? CODES.get(code) : undefined;
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function bluegraceStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = bluegraceMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => bluegraceMappedStage(code),
  gaps: FORECASTS,
};
