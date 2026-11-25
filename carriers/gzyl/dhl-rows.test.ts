import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { dateHualeiDhlRows, hualeiDhlClock, isHualeiDhlGermanRow, isHualeiDhlRow } from './dhl-rows.js';

const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('DHL rows a Hualei tenant copies', () => {
  it('reads a row copied from DHL as a wall clock and the line’s own on the platform’s', () => {
    expect([row('2026-07-31 14:35:29', 'The shipment has been successfully delivered', 'Hagen'),
      row('2026-07-31 09:30:25', 'Loaded to movement / tour vehicle', 'Hagen'),
      row('2026-07-18 04:50:10', 'The instruction data for this shipment have been provided by the sender to DHL electronically', 'DE'),
      row('2026-07-17 19:03:04', 'Departed from sort facility', 'SZS', 'SHIPMENT'), row('2026-07-17 07:39:56', 'Shipment information received')]
      .map(hualeiDhlClock)).toEqual(['wall', 'wall', 'wall', 'platform', 'platform']);
    expect(['The instruction data for this shipment have been provided by the sender to DHL electronically',
      'The shipment has been processed in the parcel center of origin'].every(isHualeiDhlGermanRow)).toBe(true);
    expect(isHualeiDhlGermanRow('The shipment has been processed in the destination parcel center')).toBe(false);
    expect(['Arrived at origin facility', 'Order Received', 'International flight has arrived'].some(isHualeiDhlRow)).toBe(false);
  });

  it('dates DHL’s rows on a named town’s clock, else Germany’s or the destination’s, and leaves the line’s own', () => {
    const result: CarrierResult = {
      status: 'delivered', last_status_text: 'The shipment has been successfully delivered', last_update: null,
      last_update_local: '2026-07-31T14:35:29', expected_delivery: null, destination_country: 'NL',
      events: [
        { local_time: '2026-07-31T14:35:29', location: 'Hagen', description: 'The shipment has been successfully delivered' },
        { local_time: '2026-07-30T08:00:00', description: 'The shipment is on its way to the destination parcel center' },
        { local_time: '2026-07-18T04:50:10', description: 'The instruction data for this shipment have been provided by the sender to DHL electronically' },
        { time: '2026-07-17T19:03:04+08:00', location: 'SZS', description: 'Departed from sort facility' },
      ],
    };
    const dated = dateHualeiDhlRows(result);
    expect(dated.events!.map(({ time, time_zone: zone, time_zone_basis: basis }) => [time, zone, basis])).toEqual([
      ['2026-07-31T14:35:29+02:00', 'Europe/Berlin', 'place'],
      ['2026-07-30T08:00:00+02:00', 'Europe/Amsterdam', 'destination'],
      ['2026-07-18T04:50:10+02:00', 'Europe/Berlin', 'carrier'],
      ['2026-07-17T19:03:04+08:00', undefined, undefined],
    ]);
    expect(dated).toMatchObject({ last_update: '2026-07-31T14:35:29+02:00' });
    expect(dated).not.toHaveProperty('last_update_local');
  });
});
