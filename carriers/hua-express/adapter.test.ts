import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HuaExpressTracker } from './adapter.js';
import { HUA_EXPRESS_ORIGIN, parseHuaExpressPage, parseHuaExpressTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'HUA005816254YQ';
const REFERENCE = 'XM17KKU2738692';
const UNKNOWN = 'HUA000000000YQ';
// The lookup's moment, after the record's newest row.
const READ_AT = Date.parse('2026-11-20T16:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('HUA Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new HuaExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HUA_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(HUA_EXPRESS_ORIGIN).toBe('http://159.75.210.47:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'hua-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads every row on its wall clock, without the shipper’s details', () => {
    const result = parseHuaExpressTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'wording:language', last_status_text: 'Parcel is out for delivery.', last_update: null, last_update_local: '2026-11-19T07:45:26', service_name: '美国特惠保健品', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-11-19T07:45:26', 'Parcel is out for delivery.', 'US, GA', undefined, 'out_for_delivery', 'wording:language'],
      ['2026-11-16T16:45:57', 'Parcel received by local Facility.', 'US, GA', undefined, 'in_transit', 'wording:language'],
      ['2026-11-15T22:16:08', 'Parcel departed from Facility.', 'US, NJ', undefined, 'in_transit', 'wording:language'],
      ['2026-11-15T17:06:53', 'Parcel received by NJC01.', 'US, NJ', undefined, 'in_transit', 'carrier_map'],
      ['2026-11-15T15:45:00', 'The customs clearance of the destination country has been completed', 'New York', undefined, 'in_transit', 'wording:language'],
      ['2026-11-14T17:41:00', 'Customs clearance in progress', 'New York', undefined, 'customs', 'wording:language'],
      ['2026-11-14T12:45:00', 'Arriving at the destination airport', 'New York', undefined, 'in_transit', 'wording:language'],
      ['2026-11-10T21:33:57', 'Goods leaving the operation center', 'SHENZHEN', 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2026-11-10T21:32:33', 'Arrived at the receiving point', 'SHENZHEN', 'ARRIVAL', 'accepted', 'carrier_map'],
      ['2026-11-10T08:32:34', 'Shipping Order Created.', 'US, NJ', undefined, 'registered', 'wording:language'],
      ['2026-11-09T11:49:33', 'Parcel Data Received', undefined, undefined, 'registered', 'wording:language'],
    ]);
    // Rows the tracker wrote ahead of their clocks are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(1);
    expect(result.delivery_carrier ?? result.delivery_tracking_number ?? result.canonical_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['SAMPLE', REFERENCE]) expect(text, value).not.toContain(value);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseHuaExpressTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${HUA_EXPRESS_ORIGIN}/trackIndex.htm`);
    expect(() => parseHuaExpressPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'hua-express', providerCode: 'ARRIVAL', description: 'Arrived at the receiving point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
