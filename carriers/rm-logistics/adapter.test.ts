import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, RmLogisticsTracker } from './adapter.js';
import { RM_LOGISTICS_ORIGIN, parseRmLogisticsPage, parseRmLogisticsTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'FK0000000668246TM';
const REFERENCE = 'XM29H55106962';
const UNKNOWN = 'FK0000000000000TM';
// The lookup's moment, after the record's newest row.
const READ_AT = Date.parse('2026-11-20T16:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('RM Logistics tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new RmLogisticsTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${RM_LOGISTICS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(RM_LOGISTICS_ORIGIN).toBe('http://129.211.2.64:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'rm-logistics', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads every row on its wall clock, without the shipper’s details', () => {
    const result = parseRmLogisticsTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_status_text: 'Delivered. Position: Front door', last_update: null, last_update_local: '2026-09-15T13:07:41', service_name: '美国标准商派专线-特货', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-09-15T13:07:41', 'Delivered. Position: Front door', 'SUFFOLK, VA', undefined, 'delivered', 'wording:language'],
      ['2026-09-15T08:08:35', 'Out for Delivery', 'SUFFOLK, VA', undefined, 'out_for_delivery', 'wording:language'],
      ['2026-09-14T09:08:10', 'Arrival at Destination Facility', 'Linden, NJ', undefined, 'in_transit', 'wording:language'],
      ['2026-09-14T01:34:20', 'In transit to destination facility', 'Linden, NJ', undefined, 'in_transit', 'wording:language'],
      ['2026-09-13T09:24:36', 'Processing at Designated Facility', 'Linden, NJ', undefined, 'in_transit', 'wording:language'],
      ['2026-09-12T09:12:00', 'Arrived at facility', 'US', undefined, 'in_transit', 'wording:language'],
      ['2026-09-11T19:34:00', 'Warehouse pickup', 'US', undefined, 'in_transit', 'carrier_map'],
      ['2026-09-11T19:11:00', 'Clearance processing completed - Import', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-09-11T11:22:00', 'Customs clearance is in progress', undefined, undefined, 'customs', 'wording:language'],
      ['2026-09-11T06:03:00', 'International flight has arrived', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-09-10T13:41:00', 'International flight has departed', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-09-09T15:18:28', '到达收货点', '义乌', 'ARRIVAL', 'accepted', 'carrier_map'],
      ['2026-09-09T06:22:11', 'Arrived at the origin international airport', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-09-09T02:02:59', 'Shipment is in transit to next facility', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-09-08T21:06:38', 'The shipment is being transshipped via the hub', 'CN', undefined, 'in_transit', 'carrier_map'],
      ['2026-09-08T07:00:21', 'Shipping Label Created', 'Linden, NJ', undefined, 'registered', 'wording:language'],
      ['2026-07-03T14:11:11', 'The electronic information of the goods has been received', undefined, undefined, 'registered', 'wording:language'],
      ['2026-07-03T14:11:10', 'Parcel Data Received', undefined, undefined, 'registered', 'wording:language'],
    ]);
    expect(result.written_ahead).toBeUndefined();
    expect(result.delivery_carrier ?? result.delivery_tracking_number ?? result.canonical_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['SAMPLE', REFERENCE]) expect(text, value).not.toContain(value);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseRmLogisticsTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${RM_LOGISTICS_ORIGIN}/trackIndex.htm`);
    expect(() => parseRmLogisticsPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'rm-logistics', providerCode: 'ARRIVAL', description: '到达收货点' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
