import { carrierIdFromName } from '../../core/catalog/hints.js';
import { returnTripStart } from '../../core/catalog/statusMaps.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/language.js';

/** The movements of a trip, which on the way back are the return. */
const TRIP = new Set(['accepted', 'in_transit', 'out_for_delivery', 'ready_for_pickup', 'delivered']);

/**
 * A provider's copy of a history whose carrier's own answer reads the scans after a return began as the trip
 * back (`returnTrip` on its status map), read the same way. From the oldest scan the carrier's map reads as the
 * return, every scan is on the return leg, its movements and the scans the map reads as the return are
 * `returned`, and the sender's delivery is the return's end. The parcel's carrier is the one it was asked about, else the one the provider names
 * (`discovered_carrier`); a scan naming another carrier (`reporting_carrier`) starts nothing. When a scan this
 * restages becomes the newest with a stage, the result's stage follows it.
 */
export function withReturnTrip(result: CarrierResult, carrier?: string | null): CarrierResult {
  const events: CarrierEvent[] = Array.isArray(result.events) ? result.events : [];
  const parcel = carrier && carrier !== 'unknown' ? carrier
    : typeof result.discovered_carrier === 'string' ? result.discovered_carrier : null;
  const starts = parcel ? returnTripStart(parcel) : undefined;
  if (!starts || !events.length) return result;
  const startsReturn = (event: CarrierEvent) => (typeof event.reporting_carrier !== 'string'
    || carrierIdFromName(event.reporting_carrier) === parcel) && starts(event.description ?? '');
  // Newest first, so the oldest scan that starts the return is the last.
  let start = events.length - 1;
  while (start >= 0 && !startsReturn(events[start]!)) start--;
  if (start < 0) return result;
  const restaged = new Set<CarrierEvent>();
  const trip = events.map((event, index): CarrierEvent => {
    if (index > start) return event;
    // The provider's rules can read the return itself otherwise, as an exception.
    if (!TRIP.has(event.stage ?? '') && (event.stage === 'returned' || !startsReturn(event))) {
      return event.provider_leg === 'return' ? event : { ...event, provider_leg: 'return' };
    }
    const back: CarrierEvent = { ...event, stage: 'returned', stage_source: 'carrier_map', provider_leg: 'return',
      ...(event.stage === 'delivered' ? { description: 'Returned to the sender' } : {}) };
    restaged.add(back);
    return back;
  });
  const current = trip.find((event) => event.stage && event.stage !== 'pending');
  return { ...result, events: trip, ...(current && restaged.has(current) ? {
    status: languageStageStatus('returned'), current_stage: 'returned', current_stage_source: 'carrier_map',
  } : {}) };
}
