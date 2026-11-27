// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { returnTripStart } from '../../core/catalog/statusMaps.js';
import { withReturnTrip } from './returnTrip.js';

// Synthetic USPS wordings, newest first, as a provider relays them.
const scan = (time: string, description: string, stage: string, extra: Partial<CarrierEvent> = {}): CarrierEvent =>
  ({ time, description, stage, stage_source: 'wording:shared', ...extra });
const history = (): CarrierEvent[] => [
  scan('2026-11-01T18:54:00Z', 'Arrived at USPS Facility', 'in_transit'),
  scan('2026-11-01T18:25:00Z', 'Departed USPS Facility', 'in_transit'),
  scan('2026-10-30T19:40:00Z', 'Refused', 'returned'),
  scan('2026-10-30T19:13:00Z', 'Return to Sender Processed', 'returned'),
  scan('2026-10-30T15:02:00Z', 'Out for Delivery', 'out_for_delivery'),
  scan('2026-10-30T12:01:00Z', 'Arrived at USPS Facility', 'in_transit'),
];
const answer = (events: CarrierEvent[], extra: Partial<CarrierResult> = {}): CarrierResult =>
  ({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:shared', events, ...extra });

describe('a provider copy of a USPS return', () => {
  it('reads the scans after the return began as the trip back, as USPS does', () => {
    const read = withReturnTrip(answer(history()), 'usps');
    expect(read).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(read.events!.map((event) => [event.description, event.stage, event.provider_leg ?? null])).toEqual([
      ['Arrived at USPS Facility', 'returned', 'return'],
      ['Departed USPS Facility', 'returned', 'return'],
      ['Refused', 'returned', 'return'],
      ['Return to Sender Processed', 'returned', 'return'],
      ['Out for Delivery', 'out_for_delivery', null],
      ['Arrived at USPS Facility', 'in_transit', null],
    ]);
    expect(read.events![0]).toMatchObject({ stage_source: 'carrier_map' });
  });

  it("reads the sender's delivery as the return's end", () => {
    const events = [scan('2026-11-04T16:00:00Z', 'Delivered, To Original Sender', 'delivered'), ...history()];
    const read = withReturnTrip(answer(events, { status: 'delivered', current_stage: 'delivered' }), 'usps');
    expect(read).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(read.events![0]).toMatchObject({ description: 'Returned to the sender', stage: 'returned', provider_leg: 'return' });
  });

  it("reads the return by USPS's map where the provider's rules read it otherwise", () => {
    const events = history().map((event) => event.description === 'Return to Sender Processed' ? { ...event, stage: 'exception' } : event);
    const read = withReturnTrip(answer(events), 'usps');
    expect(read.events![3]).toMatchObject({ stage: 'returned', stage_source: 'carrier_map', provider_leg: 'return' });
  });

  it('takes the carrier the provider names when it was asked about none', () => {
    expect(withReturnTrip(answer(history(), { discovered_carrier: 'usps' }), null)).toMatchObject({ current_stage: 'returned' });
    expect(withReturnTrip(answer(history(), { discovered_carrier: 'usps' }), 'unknown')).toMatchObject({ current_stage: 'returned' });
  });

  it("leaves other carriers' histories, and a return another carrier's scan tells, as they are", () => {
    const other = answer(history());
    expect(withReturnTrip(other, 'la-poste')).toBe(other);
    expect(withReturnTrip(other, null)).toBe(other);
    const relayed = answer(history().map((event) => ({ ...event, reporting_carrier: 'Canada Post' })));
    expect(withReturnTrip(relayed, 'usps')).toBe(relayed);
    const unreturned = answer(history().slice(4));
    expect(withReturnTrip(unreturned, 'usps')).toBe(unreturned);
  });

  it("starts the trip on USPS's own reading of the wording", () => {
    const starts = returnTripStart('usps')!;
    expect(starts('Return to Sender Processed')).toBe(true);
    expect(starts('REFUSED')).toBe(true);
    expect(starts('Arrived at USPS Facility')).toBe(false);
    expect(returnTripStart('la-poste')).toBeUndefined();
    expect(returnTripStart('unknown')).toBeUndefined();
  });
});
