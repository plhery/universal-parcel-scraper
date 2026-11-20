import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TuomeidaTracker } from './adapter.js';
import { TUOMEIDA_ORIGIN, parseTuomeidaPage, parseTuomeidaTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'TM0000003945802';
const REFERENCE = '7594431643906';
const UNKNOWN = 'TM0000000000000';
// The lookup's moment, after the record's newest row.
const READ_AT = Date.parse('2026-11-20T16:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Tuomeida tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new TuomeidaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'exception' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TUOMEIDA_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(TUOMEIDA_ORIGIN).toBe('http://114.132.187.44:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'tuomeida', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads every row on its wall clock, without the shipper’s details', () => {
    const result = parseTuomeidaTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'exception', current_stage_source: 'wording:language', last_status_text: 'Refused', last_update: null, last_update_local: '2026-11-18T11:28:00', service_name: '美国特惠美妆', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-11-18T11:28:00', 'Refused', 'SAYVILLE, NY', undefined, 'exception', 'wording:language'],
      ['2026-11-18T11:27:00', 'Arrived at Post Office', 'SAYVILLE, NY', undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T06:33:00', 'Arrived at USPS Facility', 'SAYVILLE, NY', undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T06:23:00', 'Departed USPS Facility', 'BAYPORT, NY', undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T06:17:00', 'Arrived at USPS Facility', 'BAYPORT, NY', undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T05:38:00', 'Departed USPS Facility', 'MID NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-17T17:07:00', 'Arrived at USPS Facility', 'MID NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-17T15:10:00', 'Departed USPS Facility', 'JERSEY CITY NJ DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-17T11:49:00', 'Arrived at USPS Facility', 'JERSEY CITY NJ DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-14T10:09:00', 'Return to Sender Processed', 'MOUNTAIN VIEW, CA', undefined, 'exception', 'wording:language'],
      ['2026-11-09T11:13:00', 'No Such Number', 'MOUNTAIN VIEW, CA', undefined, 'exception', 'carrier_map'],
      ['2026-11-09T06:10:00', 'Out for Delivery', 'MOUNTAIN VIEW, CA', undefined, 'out_for_delivery', 'wording:language'],
      ['2026-11-09T04:02:00', 'Arrived at Post Office', 'MOUNTAIN VIEW, CA', undefined, 'in_transit', 'wording:language'],
      ['2026-11-09T03:49:00', 'Departed USPS Facility', 'SAN FRANCISCO CA DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-08T11:01:00', 'Arrived at USPS Facility', 'SAN FRANCISCO CA DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-05T15:30:00', 'Arrived at USPS Facility', 'METRO NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-05T14:15:00', 'Accepted at USPS Facility', 'METRO NY DISTRIBUTION CENTER', undefined, 'accepted', 'wording:language'],
      ['2026-11-03T13:57:28', 'Shipment Depart From Transit Airport', 'US', undefined, 'in_transit', 'wording:language'],
      ['2026-11-02T16:23:07', 'Released From Import Customs', 'US', undefined, 'in_transit', 'wording:language'],
      ['2026-10-30T20:01:13', 'The flight has arrived.', 'US', undefined, 'in_transit', 'wording:language'],
      ['2026-10-30T03:30:24', 'The flight has departed.', 'CN', undefined, 'in_transit', 'wording:language'],
      ['2026-10-29T20:40:42', 'Arrived Export Airport', 'CN', undefined, 'in_transit', 'wording:language'],
      ['2026-10-29T14:58:54', 'Customs cleared to the airport.', 'CN', undefined, 'in_transit', 'wording:language'],
      ['2026-10-27T20:44:38', 'Package has left the operations center', '深圳', 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2026-10-24T20:38:14', 'Arrival at the collection center', '深圳', 'ARRIVAL', 'accepted', 'carrier_map'],
      ['2026-10-24T10:27:28', 'The electronic cargo information has been received', undefined, undefined, 'registered', 'wording:language'],
    ]);
    // Rows the tracker wrote ahead of their clocks are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(1);
    expect(result.delivery_carrier ?? result.delivery_tracking_number ?? result.canonical_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['SAMPLE', REFERENCE]) expect(text, value).not.toContain(value);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseTuomeidaTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${TUOMEIDA_ORIGIN}/trackIndex.htm`);
    expect(() => parseTuomeidaPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'tuomeida', providerCode: 'ARRIVAL', description: 'Arrival at the collection center' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
