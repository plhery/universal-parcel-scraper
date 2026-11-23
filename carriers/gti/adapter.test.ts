import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GtiTracker } from './adapter.js';
import { GTI_ORIGIN, parseGtiPage, parseGtiTrack, splitGtiRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'GTI2239196321112';
const REFERENCE = 'FC25021116117028';
const UNKNOWN = 'GTI0000000000001';
// The lookup's moment, after the delivery.
const READ_AT = Date.parse('2026-11-23T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GTI tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new GtiTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GTI_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(GTI_ORIGIN).toBe('http://gti568.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'gti', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its own rows on Beijing time and the USPS rows it copies as wall clocks, each once', () => {
    const result = parseGtiTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language', last_status_text: 'Delivered, PO Box',
      last_update: null, last_update_local: '2025-03-03T08:38:00', service_name: 'DH英美专线小包-F', destination_country: 'US',
    });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2025-03-03T08:38:00', 'Delivered, PO Box', 'LAWRENCE, MA', undefined, 'delivered', 'wording:language'],
      ['2025-03-03T06:10:00', 'Out for Delivery', 'NORTH ANDOVER, MA', undefined, 'out_for_delivery', 'wording:language'],
      ['2025-03-03T06:10:00', 'Out for Delivery, Expected Delivery by 5:35pm', 'NORTH ANDOVER, MA', undefined, 'out_for_delivery', 'wording:language'],
      ['2025-03-03T04:47:00', 'Arrived at Post Office', 'LAWRENCE, MA', undefined, 'in_transit', 'wording:language'],
      ['2025-03-02T23:10:00', 'Arrived at USPS Regional Destination Facility', 'MIDDLESEX-ESSEX MA DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2025-03-02T20:34:00', 'Arrived at USPS Regional Destination Facility', 'BOSTON MA DISTRIBUTION CENTER', undefined, 'in_transit', 'wording:language'],
      ['2025-02-15T10:39:32+08:00', '货物离开操作中心', '莆田', 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2025-02-15T04:19:00', 'Departed Shipping Partner Facility', 'JAMAICA, NY', undefined, 'in_transit', 'wording:language'],
      ['2025-02-15T02:19:00', 'Arrived Shipping Partner Facility', 'JAMAICA, NY', undefined, 'in_transit', 'wording:language'],
      ['2025-02-15T00:19:00', 'Picked Up By Shipping Partner', 'JAMAICA, NY', undefined, 'accepted', 'wording:language'],
      ['2025-02-14T22:11:38+08:00', '到达收货点', '莆田', 'ARRIVAL', 'accepted', 'carrier_map'],
    ]);
    // The platform's scripted rows from the airport to customs are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(7);
    expect(result.planned_events!.map((event) => event.description)).toEqual([
      '快件到达机场', '快件到达始发地海关【深圳市],等待清关', '出口清关完成', '交航', '启运【SZX】', '抵达【LAX】', '目的国清关完成',
    ]);
    expect(result.planned_events!.every((event) => event.stage === 'in_transit')).toBe(true);
    const text = JSON.stringify(result);
    for (const value of ['01840', '11434', '?', '->', 'Your item', 'SAMPLE', REFERENCE]) expect(text, value).not.toContain(value);
  });

  it('gives back the spaces a copied row lost and drops a row with only its place', () => {
    expect(splitGtiRow('JAMAICA,?NY?11434, Arrived Shipping Partner Facility,', 'JAMAICA,?NY?11434'))
      .toEqual({ content: 'Arrived Shipping Partner Facility', location: 'JAMAICA, NY' });
    expect(splitGtiRow('JAMAICA,?NY?11434, ,', 'JAMAICA,?NY?11434')).toEqual({ content: '', location: '' });
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseGtiTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${GTI_ORIGIN}/trackIndex.htm`);
    expect(() => parseGtiPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('抵达【JFK】'))).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'gti', providerCode: 'ARRIVAL', description: '到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    // USPS's own wordings are left to the shared rules.
    expect(statusMapAnswer({ carrier: 'gti', providerCode: null, description: 'Arrived Shipping Partner Facility' })).toEqual({ kind: 'unknown' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
