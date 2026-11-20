import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BenbenTracker } from './adapter.js';
import { BENBEN_ORIGIN, parseBenbenPage, parseBenbenTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'BEN25250914BEN';
const REFERENCE = '892631274260291';
const UNKNOWN = 'BEN00000000BEN';
// The lookup's moment, after the record's newest row.
const READ_AT = Date.parse('2026-11-20T16:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Benben tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new BenbenTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BENBEN_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(BENBEN_ORIGIN).toBe('http://119.29.253.160:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'benben', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads every row on its wall clock, without the shipper’s details', () => {
    const result = parseBenbenTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language', last_status_text: 'Item in transit', last_update: null, last_update_local: '2026-11-18T16:10:21', service_name: '犇犇美国经济专线 - 普货', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, description, location, provider_code, stage, stage_source }) =>
      [time ?? local_time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-11-18T16:10:21', 'Item in transit', 'US', undefined, 'in_transit', 'wording:language'],
      ['2026-11-16T11:07:46', 'Custom clearance completed', 'US', undefined, 'in_transit', 'wording:language'],
      ['2026-11-15T15:27:38', 'The package is being submitted for customs clearance', 'US', undefined, 'customs', 'wording:language'],
      ['2026-11-13T19:20:46', 'Export customs declaration completed', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-11-13T14:46:52', 'Arrived at export airport', undefined, undefined, 'in_transit', 'wording:language'],
      ['2026-11-12T13:26:18', 'Cargo leaving the operation center', 'Warehouse', 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2026-11-12T02:41:15', 'Arrive at the delivery point', 'Warehouse', 'ARRIVAL', 'accepted', 'carrier_map'],
      ['2026-11-09T21:44:16', 'Parcel Data Received,Label Created', undefined, undefined, 'registered', 'wording:language'],
    ]);
    // Rows the tracker wrote ahead of their clocks are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(2);
    expect(result.delivery_carrier ?? result.delivery_tracking_number ?? result.canonical_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['SAMPLE', REFERENCE]) expect(text, value).not.toContain(value);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseBenbenTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${BENBEN_ORIGIN}/trackIndex.htm`);
    expect(() => parseBenbenPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'benben', providerCode: 'ARRIVAL', description: 'Arrive at the delivery point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});
