import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YuanpengTracker } from './adapter.js';
import { parseYuanpengPage, parseYuanpengTrack, YUANPENG_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'YP0168865416KD';
const REFERENCE = 'XMUN36K52124';
const USPS = '9214490416421002545694';
const UNKNOWN = 'YP0000000000KD';
// The lookup's moment, after the delivery.
const READ_AT = Date.parse('2026-11-20T16:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Yuanpeng tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new YuanpengTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${YUANPENG_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(YUANPENG_ORIGIN).toBe('http://www.yuanpeng56.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'yuanpeng', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its own rows on Beijing time and the USPS rows it copies as wall clocks, and names the USPS number', () => {
    const result = parseYuanpengTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_status_text: 'Delivered, In/At Mailbox',
      last_update: null, last_update_local: '2026-11-19T15:17:00', service_name: '远朋美国食品小包专线', destination_country: 'US',
      delivery_carrier: 'usps', delivery_tracking_number: USPS,
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-11-19T15:17:00', 'Delivered, In/At Mailbox', 'MASSENA, NY', undefined, 'delivered', 'wording:language'],
      ['2026-11-19T07:30:00', 'Out for Delivery', 'MASSENA, NY', undefined, 'out_for_delivery', 'wording:language'],
      ['2026-11-19T07:30:00', 'Out for Delivery, Expected Delivery by 7:20pm', 'MASSENA, NY', undefined, 'out_for_delivery', 'wording:language'],
      ['2026-11-19T07:19:00', 'Arrived at Post Office', 'MASSENA, NY', undefined, 'in_transit', 'wording:language'],
      ['2026-11-19T02:26:00', 'Arrived at USPS Facility', 'WATERTOWN, NY', undefined, 'in_transit', 'wording:language'],
      ['2026-11-19T00:55:00', 'Departed USPS Facility', 'SYRACUSE NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T12:55:00', 'Arrived at USPS Facility', 'SYRACUSE NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T12:00:00', 'In Transit to Next Facility', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T08:00:00', 'On the Way, In Transit, Arriving On Time', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T08:00:00', 'In Transit to Next Facility', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-11-18T05:30:00', 'Departed USPS Facility', 'QUEENS NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-17T12:47:00', 'Arrived at USPS Facility', 'QUEENS NY DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2026-11-17T11:32:00', 'Accepted at USPS Facility', 'QUEENS NY DISTRIBUTION CENTER', undefined, 'accepted', 'wording:language'],
      ['2026-11-11T02:06:00', 'Shipping Label Created', 'SPRINGFIELD GARDENS, NY', undefined, 'registered', 'wording:language'],
      ['2026-11-11', 'Pre-Shipment Info Sent to USPS', undefined, undefined, 'registered', 'carrier_map'],
      ['2026-11-09T20:54:58+08:00', `Last Mile Tracking Number ${USPS}`, undefined, undefined, undefined, undefined],
      ['2026-11-09T20:54:58+08:00', 'Goods leaving the processing center', 'shenzhen', 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2026-11-09T15:57:44+08:00', 'Arriving at the receiving point', 'shenzhen', 'ARRIVAL', 'accepted', 'carrier_map'],
    ]);
    // The platform's scripted rows from the airport to customs are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(8);
    expect(result.planned_events!.map((event) => event.description)).toContain('In clearance processing');
    const text = JSON.stringify(result);
    for (const value of ['13662', '->', 'Your item', 'SAMPLE', REFERENCE]) expect(text, value).not.toContain(value);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseYuanpengTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${YUANPENG_ORIGIN}/trackIndex.htm`);
    expect(() => parseYuanpengPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'yuanpeng', providerCode: 'ARRIVAL', description: 'Arriving at the receiving point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    // USPS's own wordings are left to the shared rules.
    expect(statusMapAnswer({ carrier: 'yuanpeng', providerCode: null, description: 'Arrived at USPS Facility' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
