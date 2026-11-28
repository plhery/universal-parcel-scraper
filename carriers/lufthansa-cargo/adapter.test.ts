import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeLufthansaCargoNumber, parseLufthansaCargo } from './parser.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Synthetic replies shaped as the eTracking script reads them; the not-found reply is a public sample's.
const delivered = fixture('delivered.json');
const inTransit = fixture('in-transit.json');
const notFound = fixture('not-found.json');
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lufthansa Cargo air waybills', () => {
  it('takes the 020 prefix with or without a separator, or the serial alone, and checks its digit', () => {
    expect(normalizeLufthansaCargoNumber('020-12345675')).toBe('02012345675');
    expect(normalizeLufthansaCargoNumber('020 12345675')).toBe('02012345675');
    expect(normalizeLufthansaCargoNumber('02012345675')).toBe('02012345675');
    expect(normalizeLufthansaCargoNumber('12345675')).toBe('02012345675');
    expect(() => normalizeLufthansaCargoNumber('020-12345676')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeLufthansaCargoNumber('724-12345675')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('asks the eTracking service for the whole waybill and reads its delivery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
    const result = await tracker(fetcher).track({ number: '020-12345675' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api-external.lufthansa-cargo.com/stp/shipments-details/02012345675');
    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBe('https://www.lufthansa-cargo.com');
    expect(headers.has('authorization')).toBe(false);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'DLV', last_status_text: 'Delivered',
      last_update: '2026-11-20T09:26:00-06:00',
    });
    expect(result).not.toHaveProperty('planned_events');
  });

  it('keeps each station’s offset, the tracker’s order, the flights and the offload', () => {
    const { events = [] } = parseLufthansaCargo(delivered, '02012345675');
    expect(events[0]).toMatchObject({ provider_code: 'DLV', location: 'ORD', time: '2026-11-20T09:26:00-06:00', stage: 'delivered' });
    expect(events.at(-1)).toMatchObject({ provider_code: 'BKD', description: 'Booking confirmed', location: 'MUC', stage: 'registered' });
    expect(events.find(event => event.provider_code === 'DIS')).toMatchObject({
      description: 'Offload (OFLD), flight LH430', location: 'FRA', time: '2026-11-18T13:40:00+01:00',
    });
    expect(events.find(event => event.provider_code === 'DIS')).not.toHaveProperty('stage');
    expect(events.find(event => event.provider_code === 'MAN')).not.toHaveProperty('stage');
    expect(events.find(event => event.provider_code === 'DEP')).toMatchObject({ description: 'Departed, flight LH8160', location: 'FRA' });
    expect(events.some(event => event.local_time)).toBe(false);
    expect(events).toHaveLength(14);
  });

  it('keeps the steps still to come as planned and the latest done step as the status', () => {
    const result = parseLufthansaCargo(inTransit, '02012345686');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', provider_code: 'DEP', last_status_text: 'Departed, flight LH430',
    });
    expect(result.events).toHaveLength(8);
    expect(result.planned_events).toEqual([
      expect.objectContaining({ description: 'Arrived, flight LH430', location: 'ORD', time: '2026-11-18T12:50:00-06:00' }),
      expect.objectContaining({ description: 'Received from flight, flight LH430', location: 'ORD' }),
      expect.objectContaining({ description: 'Ready for pick-up', location: 'ORD', stage: 'ready_for_pickup' }),
    ]);
  });

  it('keeps a station’s wall clock when the tracker gives no offset, and files a delivery away from the destination in transit', () => {
    const data = structuredClone(delivered) as { statusHistories: Record<string, unknown>[] };
    data.statusHistories = data.statusHistories.slice(0, 6);
    data.statusHistories[5] = { cargoEventType: 'DLV', stationAirport: { airportCode: 'FRA' }, actualCargoEvent: { eventDateTime: '2026-11-18T03:05:00' } };
    const result = parseLufthansaCargo(data, '02012345675');
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DLV', local_time: '2026-11-18T03:05', stage: 'in_transit' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2026-11-18T03:05' });
  });

  it('requires the requested waybill before reading its history', () => {
    expect(() => parseLufthansaCargo(delivered, '02012345686')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports a waybill the guest tracker does not show as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(notFound));
    await expect(tracker(fetcher).track({ number: '020-45286732' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take a refusal, a moved service or an unreadable reply for a missing waybill', async () => {
    const refused = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><title>Access Denied</title></html>', { status: 403 }));
    await expect(tracker(refused).track({ number: '020-12345675' })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(tracker(moved).track({ number: '020-12345675' })).rejects.toMatchObject({ kind: 'schema' });
    const garbled = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html></html>'));
    await expect(tracker(garbled).track({ number: '020-12345675' })).rejects.toMatchObject({ kind: 'schema' });
    expect(() => parseLufthansaCargo({ awbNumber: { airlineCode: '020', serialNumber: '12345675' } }, '02012345675'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a listed waybill without done steps as known without history', () => {
    const data = structuredClone(inTransit) as { statusHistories: Record<string, unknown>[] };
    data.statusHistories = data.statusHistories.slice(8);
    expect(() => parseLufthansaCargo(data, '02012345686')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });
});
