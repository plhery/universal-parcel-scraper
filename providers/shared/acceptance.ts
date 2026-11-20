/**
 * An acceptance a provider relays after the parcel has moved, read as transit.
 */
import { languageStageStatus } from '../../core/status/index.js';
import { clocks, reading } from '../../core/result/registration.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';

/** Stages that show the parcel has moved. */
const MOVED = new Set(['accepted', 'in_transit', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'delivered', 'returned']);
/** How long after the first movement an acceptance is still that moment's record. */
const SAME_MOMENT_MS = 60_000;

/**
 * A provider's history joins the legs of several networks, each of which words its own receipt as an
 * acceptance: a forwarder's warehouse abroad, the last-mile courier, the destination post. Only the
 * first takes the parcel in. A later acceptance, past the first movement's minute, is a hand-over on
 * the way, as the late registrations before it are: in transit. A carrier's own map that reads it as
 * an acceptance relays it under its code, and stays as it is.
 */
export function readLateAcceptances(result: CarrierResult): CarrierResult {
  const events: unknown[] = Array.isArray(result.events) ? result.events : [];
  if (events.length < 2) return result;
  const at = clocks(events);
  const order = events.flatMap((_, index) => at[index] === null ? [] : [index]).sort((left, right) => at[left]! - at[right]!);
  const first = order.find(index => MOVED.has(reading(events[index]) ?? ''));
  if (first === undefined) return result;
  const late = new Set(order.filter(index => {
    const event = events[index] as CarrierEvent;
    return at[index]! - at[first]! > SAME_MOMENT_MS && event.stage === 'accepted' && event.stage_source !== 'carrier_map'
      && event.stage_source !== 'none';
  }));
  if (!late.size) return result;
  const newest = order.filter(index => at[index] === at[order.at(-1)!]);
  const headline = result.current_stage === 'accepted' && newest.some(index => late.has(index))
    && newest.every(index => reading(events[index]) !== 'accepted' || late.has(index));
  return {
    ...result,
    ...(headline ? { current_stage: 'in_transit', status: languageStageStatus('in_transit') } : {}),
    events: events.map((event, index) => late.has(index) ? { ...event as CarrierEvent, stage: 'in_transit' } : event) as CarrierEvent[],
  };
}
