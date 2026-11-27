import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The stage codes of DispatchTrack's order snapshot, as its tracker's script
 * reads them for its progress rail. The tracker shows `assigned` as Scheduled,
 * the driver's three steps before the drop as Out for delivery, and a stop the
 * driver could not complete, cancelled or completed only in part as final.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // A delivery day is set; the driver's route has not started.
  ['assigned', 'registered'],
  // The driver's route has started with a pickup before this order's drop.
  ['en_route_pickup', 'in_transit'],
  ['at_pickup', 'in_transit'],
  ['en_route_drop', 'out_for_delivery'],
  // The driver is at the drop.
  ['arrived', 'out_for_delivery'],
  ['completed', 'delivered'],
  // The stop ended with part of the order delivered; the rail leaves its Delivered step open.
  ['partial', 'exception'],
  ['failed', 'failed_attempt'],
  ['cancelled', 'exception'],
]);

/** The stage the map gives a snapshot's stage code, if it knows it. */
export function dispatchTrackCodeStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/** A snapshot's stage code read by the map, or nothing for a code it does not know. */
export function dispatchTrackStage(code: string): ClassifiedWording | null {
  const stage = dispatchTrackCodeStage(code);
  return stage ? { stage, source: 'carrier_map' } : null;
}

/** What the map says about a snapshot's stage code. High Energy Transport's tracker writes no events. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? dispatchTrackCodeStage(code) : undefined),
  gaps: [],
};
