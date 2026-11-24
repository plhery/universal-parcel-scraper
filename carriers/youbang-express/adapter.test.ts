import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YoubangExpressTracker } from './adapter.js';
import { parseYoubangExpressPage, parseYoubangExpressTrack, splitYoubangExpressRow, YOUBANG_EXPRESS_ORIGIN } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'YB9999999980CN';
const REFERENCE = 'XX0000000000001';
const UNKNOWN = 'YB9900000009CN';
// The lookup's moment, after the record's newest row.
const READ_AT = Date.parse('2026-03-10T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('YouBang Express numbers', () => {
  it('keeps its low rule and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['youbang-express'] });
    expect(parseTrackingInput(`http://119.29.254.121:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'youbang-express' });
    expect(carrierIdFromName('YBWL')).toBe('youbang-express');
  });
});

describe('YouBang Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new YoubangExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${YOUBANG_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(YOUBANG_EXPRESS_ORIGIN).toBe('http://119.29.254.121:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'youbang-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps the warehouse’s rows on Beijing time and names the platform’s scripted rows as planned', () => {
    const result = parseYoubangExpressTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: '货物离开操作中心',
      last_update: '2026-03-03T09:41:52+08:00', service_name: 'Europe Small Parcel Standard Line', destination_country: 'DE',
    });
    expect(result.events!.map(({ time, description, location, provider_code, stage, stage_source }) =>
      [time, description, location, provider_code, stage, stage_source])).toEqual([
      ['2026-03-03T09:41:52+08:00', '货物离开操作中心', undefined, 'SHIPMENT', 'in_transit', 'carrier_map'],
      ['2026-03-02T11:20:14+08:00', '到达收货点', undefined, 'ARRIVAL', 'accepted', 'carrier_map'],
    ]);
    // The custom track product's rows, from export clearance to the delivery, are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(10);
    expect(result.planned_events!.map(({ description, stage }) => [description, stage])).toEqual([
      ['exit customs clearance complete', 'in_transit'], ['Wait for a flight', 'in_transit'], ['To be shipped by airline', 'in_transit'],
      ['SZX, FLIGHT DEPARTED', 'in_transit'], ['FLIGHT ARRIVED', 'in_transit'], ['lmport customs clearance complete', 'in_transit'],
      ['Item Received', 'in_transit'], ['Hand it over to local service provider, waiting for pickup', 'in_transit'],
      ['Due to be delivered today', 'out_for_delivery'], ['Delivered, Front Door/Porch', 'delivered'],
    ]);
    expect(result.canonical_tracking_number ?? result.delivery_carrier ?? result.delivery_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of [REFERENCE, 'YB000', '"."']) expect(text, value).not.toContain(value);
  });

  it('reads a place without a letter or digit as none', () => {
    expect(splitYoubangExpressRow('到达收货点', '.')).toEqual({ content: '到达收货点', location: '' });
    expect(splitYoubangExpressRow('SZX, FLIGHT DEPARTED', 'CN')).toEqual({ content: 'SZX, FLIGHT DEPARTED', location: 'CN' });
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseYoubangExpressTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${YOUBANG_EXPRESS_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(parseYoubangExpressTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    expect(() => parseYoubangExpressPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YB99', 'YB9999999980CN,YB9900000009CN']) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('<html><body>维护中</body></html>')))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    // Another failure than its unknown-number answer leaves the lookup open.
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'false', message: '系统繁忙' }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('maps every wording it lists, the scripted flight row whatever its airport, and the app reads the map', () => {
    for (const entry of ENTRIES) expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'youbang-express', providerCode: 'ARRIVAL', description: '到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'youbang-express', providerCode: 'CO_C_CR', description: 'HKG, FLIGHT DEPARTED' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'youbang-express', providerCode: 'CO_C_CR', description: 'Item Received' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMap.stage(null, normalizeStatusWording('SZX, FLIGHT DEPARTED TODAY'))).toBeUndefined();
  });
});
