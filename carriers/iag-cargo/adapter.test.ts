import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeIagCargoNumber, parseIagCargo } from './parser.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Synthetic replies shaped as the tracker's page reads them.
const delivered = fixture('delivered.json');
const inTransit = fixture('in-transit.json');
// The service's answer to a public sample it no longer holds.
const notFoundText = 'There was no AWB found with the following number: 125-47701614.';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
type Reply = { awb: Record<string, unknown>; journeyStations: { milestones: Record<string, unknown>[] }[]; shipmentStatusDetails: Record<string, unknown> };
const copy = (data: unknown) => structuredClone(data) as Reply;

describe('IAG Cargo air waybills', () => {
  it('takes the British Airways, Iberia and Aer Lingus prefixes with or without a separator, and checks the digit', () => {
    expect(normalizeIagCargoNumber('125-12345675')).toBe('125-12345675');
    expect(normalizeIagCargoNumber(' 075 12345686 ')).toBe('075-12345686');
    expect(normalizeIagCargoNumber('05312345675')).toBe('053-12345675');
    expect(() => normalizeIagCargoNumber('12345675')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeIagCargoNumber('125-12345676')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeIagCargoNumber('020-12345675')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('asks the tracking service for the waybill with its dash and reads its delivery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
    const result = await tracker(fetcher).track({ number: '12512345675' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.tracking.iagcargo.com/tracking/125-12345675');
    const headers = new Headers(init?.headers);
    expect(headers.get('origin')).toBe('https://ui.tracking.iagcargo.com');
    expect(headers.get('accept')).toContain('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'DLV', last_status_text: 'Delivered',
      last_update: '2026-11-19T14:02:00Z', destination_country: 'ZA',
    });
    expect(result).not.toHaveProperty('planned_events');
  });

  it('keeps the route’s stations, the flights, the truck and the offload, and leaves out duplicated entries', () => {
    const { events = [] } = parseIagCargo(delivered, '125-12345675');
    expect(events.map(event => event.provider_code)).toEqual(['DLV', 'NFD', 'ARR', 'DEP', 'OFLD', 'ARR', 'DEP', 'RCS', 'BOOKED']);
    expect(events[1]).toMatchObject({ description: 'Ready for delivery', location: 'JNB', stage: 'ready_for_pickup' });
    expect(events[3]).toMatchObject({ description: 'Flight departed, flight no. BA0055 to JNB', location: 'LHR', stage: 'in_transit' });
    expect(events[4]).toMatchObject({ description: 'Offloaded from BA0057, 3 package/s', location: 'LHR', time: '2026-11-17T19:55:00Z' });
    expect(events[4]).not.toHaveProperty('stage');
    expect(events[6]).toMatchObject({ description: 'Flight departed, truck no. BA9620 to LHR', location: 'MAN' });
    expect(events[8]).toMatchObject({ description: 'Your shipment has been booked', location: 'MAN', stage: 'registered', time: '2026-11-15T10:12:00Z' });
    expect(events.some(event => event.local_time)).toBe(false);
  });

  it('keeps the steps still to come as planned, at the arrival time for an arrival, and counts the pieces of a part', () => {
    const result = parseIagCargo(inTransit, '075-12345686');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', provider_code: 'DEP',
      last_status_text: 'Flight departed, flight no. IB6585 to BOG (3 of 4 pieces)', last_update: '2026-11-27T23:55:00Z',
      destination_country: 'CO',
    });
    expect(result.events?.map(event => event.provider_code)).toEqual(['DEP', 'RCS', 'BOOKED']);
    expect(result.planned_events).toEqual([
      { local_time: '2026-11-28T04:50', description: 'Estimated arrival, flight no. IB6585', location: 'BOG', stage: 'in_transit' },
      { time: '2026-11-28T23:55:00Z', description: 'Planned departure, flight no. IB6587 to BOG', location: 'MAD', stage: 'in_transit' },
      { time: '2026-11-29T15:00:00Z', description: 'Estimated delivery', location: 'BOG', stage: 'ready_for_pickup' },
    ]);
  });

  it('keeps a station’s wall clock when the tracker gives no zone, and files a delivery away from the destination in transit', () => {
    const data = copy(delivered);
    data.journeyStations = data.journeyStations.slice(0, 2);
    data.journeyStations[1]!.milestones.push({ milestoneCode: 'DLV', status: 'FINE', timeIndicator: 'A', packages: 3, eventTime: '2026-11-18T21:05:00', location: { locationCode: 'LHR' } });
    const result = parseIagCargo(data, '125-12345675');
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DLV', local_time: '2026-11-18T21:05', location: 'LHR', stage: 'in_transit' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2026-11-18T21:05' });
    expect(result).not.toHaveProperty('destination_country');
  });

  it('leads with the latest other step until every piece is delivered', () => {
    const data = copy(delivered);
    Object.assign(data.journeyStations[2]!.milestones[2]!, { status: 'PARTIAL', packages: 2 });
    const result = parseIagCargo(data, '125-12345675');
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', provider_code: 'NFD' });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered (2 of 3 pieces)', stage: 'delivered' });
  });

  it('reads a booking alone as registered and a cancelled booking as an exception', () => {
    const booked = copy(inTransit);
    booked.journeyStations = [];
    expect(parseIagCargo(booked, '075-12345686')).toMatchObject({
      status: 'pending', current_stage: 'registered', provider_code: 'BOOKED', last_update: '2026-11-25T16:48:00Z',
    });
    const cancelled = copy(booked);
    Object.assign(cancelled.shipmentStatusDetails, { status: 'CANCELLED', statusUpdatedDateTime: '2026-11-26T08:00:00Z' });
    expect(parseIagCargo(cancelled, '075-12345686')).toMatchObject({
      status: 'exception', current_stage: 'exception', provider_code: 'CANCELLED', last_status_text: 'Your booking was cancelled',
    });
  });

  it('reads a listed waybill without done steps as known without history', () => {
    const data = copy(inTransit);
    data.journeyStations = data.journeyStations.slice(1);
    data.shipmentStatusDetails.bookingDateTime = '';
    expect(() => parseIagCargo(data, '075-12345686')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('requires the requested waybill before reading its history', () => {
    expect(() => parseIagCargo(delivered, '125-12345686')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unnamed = copy(delivered);
    delete unnamed.awb.awbNumber;
    expect(() => parseIagCargo(unnamed, '125-12345675')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports the waybill the service names as missing as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(notFoundText, { status: 404, headers: { 'content-type': 'application/json' } }));
    await expect(tracker(fetcher).track({ number: '125-47701614' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take a refusal, a moved service, another waybill’s answer or an unreadable reply for a missing waybill', async () => {
    const refused = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><title>Access Denied</title></html>', { status: 403 }));
    await expect(tracker(refused).track({ number: '125-12345675' })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(tracker(moved).track({ number: '125-12345675' })).rejects.toMatchObject({ kind: 'schema' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(notFoundText, { status: 404 }));
    await expect(tracker(other).track({ number: '125-12345675' })).rejects.toMatchObject({ kind: 'schema' });
    const refusedInput = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Invalid awb number', { status: 400 }));
    await expect(tracker(refusedInput).track({ number: '125-12345675' })).rejects.toMatchObject({ kind: 'schema' });
    const garbled = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html></html>'));
    await expect(tracker(garbled).track({ number: '125-12345675' })).rejects.toMatchObject({ kind: 'schema' });
    const unknownStatus = copy(delivered);
    unknownStatus.journeyStations[0]!.milestones[0]!.status = 'SOMETHING';
    expect(() => parseIagCargo(unknownStatus, '125-12345675')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseIagCargo({ journeyStations: [] }, '125-12345675')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
