import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ShengaoTracker } from './adapter.js';
import { parseShengaoPage, parseShengaoTrack, SHENGAO_ORIGIN } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'SA9999999980GJ';
const REFERENCE = 'XX0000000000001';
const UNKNOWN = 'SA9900000009GJ';
// The lookup's moment, after the record's newest row.
const READ_AT = Date.parse('2026-03-10T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SHENGAO numbers', () => {
  it('claims SA, ten digits and GJ by its shape, reads a number out of a link to its tracker and answers to its names', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'shengao', confidence: 'high' });
    for (const path of ['trackIndex.htm', 'en/trackIndex.htm']) {
      expect(parseTrackingInput(`http://www.shengaoguojiwuliu.com:8082/${path}?documentCode=${NUMBER}`))
        .toMatchObject({ trackingNumber: NUMBER, carrier: 'shengao' });
    }
    for (const name of ['SHENGAO', '盛傲物流', 'Shengao International Logistics', '深圳市盛傲国际物流有限公司']) {
      expect(carrierIdFromName(name), name).toBe('shengao');
    }
  });
});

describe('SHENGAO tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new ShengaoTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHENGAO_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(SHENGAO_ORIGIN).toBe('http://www.shengaoguojiwuliu.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'shengao', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps every row on Beijing time, the partner’s it copies too, and shows the platform’s Chinese rows in English', () => {
    const result = parseShengaoTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Shipment Data Processed',
      last_update: '2026-03-09T15:20:11+08:00', service_name: 'Europe and US Small Parcel-P', destination_country: 'GB',
    });
    expect(result.events!.map(({ time, description, location, provider_code, stage }) => [time, description, location, provider_code, stage])).toEqual([
      ['2026-03-09T15:20:11+08:00', 'Shipment Data Processed', 'Northgate Parcel Hub', undefined, 'in_transit'],
      ['2026-03-09T15:20:10+08:00', 'Shipment Received in Depot', 'Northgate Parcel Hub', undefined, 'in_transit'],
      ['2026-03-08T18:05:00+08:00', 'Custom clearance completed', undefined, undefined, 'in_transit'],
      ['2026-03-08T16:40:00+08:00', 'Parcel arrives at Transit Airport, Parcel Arrival', undefined, undefined, 'in_transit'],
      ['2026-03-08T16:31:00+08:00', 'Parcel arrives at Airport, Parcel Arrival', undefined, undefined, 'in_transit'],
      ['2026-03-08T11:15:00+08:00', 'Parcel is leaving Transit Airport, Parcel Leaving Port', undefined, undefined, 'in_transit'],
      ['2026-03-07T07:45:00+08:00', 'Parcel is leaving Airport, Parcel Leaving Port', undefined, undefined, 'in_transit'],
      ['2026-03-06T19:30:00+08:00', 'Parcel departure in Transit Facility, Parcel Departure', 'Linehaul Agent', undefined, 'in_transit'],
      ['2026-03-06T18:40:00+08:00', 'Customs declaration completed', undefined, undefined, 'in_transit'],
      ['2026-03-05T02:10:33+08:00', 'Goods leave the operation center', '深圳', 'SHIPMENT', 'in_transit'],
      ['2026-03-05T02:04:51+08:00', 'Parcel departure in Shenzhen Sorting Centre.', 'Shenzhen', undefined, 'in_transit'],
      ['2026-03-04T15:12:08+08:00', 'Parcel processed at Shenzhen Sorting Centre.', 'Shenzhen', undefined, 'in_transit'],
      ['2026-03-03T22:05:37+08:00', 'Parcel received at Shenzhen Sorting Centre.', 'Shenzhen', undefined, 'in_transit'],
      ['2026-03-03T10:48:19+08:00', 'Arrived at the receiving point', '深圳', 'ARRIVAL', 'accepted'],
    ]);
    // Rows written after their clock are scans: nothing is held back as written ahead.
    expect(result.written_ahead ?? []).toEqual([]);
    expect(result.canonical_tracking_number ?? result.delivery_carrier ?? result.delivery_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of [REFERENCE, 'SA000']) expect(text, value).not.toContain(value);
  });

  it('finds the parcel by the shipper’s reference and names its own number', () => {
    expect(parseShengaoTrack(fixture('track'), REFERENCE, READ_AT)?.canonical_tracking_number).toBe(NUMBER);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${SHENGAO_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(parseShengaoTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    expect(() => parseShengaoPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The page for one number never settles another.
    expect(() => parseShengaoPage(page('page-unknown'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SA99', 'SA9999999980GJ,SA9900000009GJ']) {
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

  it('maps every wording it lists, in Chinese and in the English it shows, and the app reads the map', () => {
    for (const entry of ENTRIES) {
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      if (entry.english) expect(statusMap.stage(null, normalizeStatusWording(entry.english)), entry.english).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'shengao', providerCode: 'ARRIVAL', description: '到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'shengao', providerCode: 'ARRIVAL', description: 'Arrived at the receiving point' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'shengao', description: 'Shipment Received in Depot' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'shengao', description: 'Out for Delivery' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'shengao', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
