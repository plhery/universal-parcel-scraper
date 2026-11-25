import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BulongguojiTracker } from './adapter.js';
import { BULONGGUOJI_ORIGIN, parseBulongguojiPage, parseBulongguojiTrack, repeatsBulongguojiRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's page, USPS's number its record holds, and a string
// in no shape the tracker issues.
const NUMBER = 'BL000000691277YQ';
const USPS = '9511677084110963357247';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BULONGGUOJI numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://106.52.54.99:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'bulongguoji' });
  });
});

describe('BULONGGUOJI tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new BulongguojiTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'usps' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BULONGGUOJI_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(BULONGGUOJI_ORIGIN).toBe('http://106.52.54.99:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'bulongguoji', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to USPS and reads USPS’s copies on their wall clocks, the line’s rows on Beijing’s', () => {
    const result = parseBulongguojiTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Parcel Locker', last_update: null, last_update_local: '2026-06-08T14:41:00',
      service_name: 'BL美国专线-化妆品', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: USPS,
    });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(25);
    // USPS's scans keep the minute USPS gave them, without a zone, their place without its ZIP code
    // and their wording without USPS's explanation after the arrow.
    expect(events[0]).toMatchObject({ local_time: '2026-06-08T14:41:00', description: 'Delivered, Parcel Locker', location: 'NASHUA, NH', stage: 'delivered' });
    expect(events[0]).not.toHaveProperty('time');
    expect(events.find(({ stage }) => stage === 'out_for_delivery')).toMatchObject({ local_time: '2026-06-08T06:10:00', description: 'Out for Delivery' });
    expect(events.at(-8)).toMatchObject({ local_time: '2026-05-28T23:40:00', description: 'Accepted at USPS Facility', location: 'CHICAGO IL DISTRIBUTION CENTER' });
    // The line's own rows come to the second on Beijing's clock.
    expect(events.find(({ provider_code: code }) => code === 'USA'))
      .toMatchObject({ time: '2026-05-20T22:17:57+08:00', description: 'InTransit_CustomsProcessing', location: 'US', stage: 'customs' });
    expect(events.find(({ provider_code: code }) => code === 'HKC')).toMatchObject({ time: '2026-05-19T15:15:46+08:00', location: 'HK', stage: 'in_transit' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2026-05-16T20:27:21+08:00', description: 'Consignment Received At Transit Point', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2026-05-16T10:05:13+08:00', stage: 'registered' });
    // Each USPS scan the tracker copies twice, with USPS's category or detail around it, counts once.
    expect(events.filter(({ local_time: local }) => local === '2026-06-08T06:10:00')).toHaveLength(1);
    expect(events.filter(({ local_time: local }) => local === '2026-06-06T18:25:00')).toEqual([expect.objectContaining({ description: 'Arrived at USPS Facility' })]);
    expect(events.map(({ description }) => description)).not.toContain('Preparing for Delivery, Arrived at Hub');
    // The platform's custom track rows are steps written ahead, not scans.
    expect(events.some(({ provider_code: code }) => code === 'CO_C_CR')).toBe(false);
    expect(result.planned_events).toEqual([
      { time: '2026-05-16T23:53:46+08:00', description: 'Item outbound in sorting center', location: 'CN', stage: 'in_transit' },
      { time: '2026-05-17T03:53:46+08:00', description: 'Departed from origin facility to airport', location: 'CN', stage: 'in_transit' },
      { time: '2026-05-17T15:53:46+08:00', description: 'InTransit_Arrival', location: 'HK', stage: 'in_transit' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/03060|03103|08865|Your item|STK/);
  });

  it('reads a wording with USPS’s category ahead or its detail after as the same scan', () => {
    expect(repeatsBulongguojiRow('on the way, arrived at usps facility', 'arrived at usps facility')).toBe(true);
    expect(repeatsBulongguojiRow('out for delivery, expected delivery by 9:00pm', 'out for delivery')).toBe(true);
    expect(repeatsBulongguojiRow('arrived at usps facility', 'departed usps facility')).toBe(false);
    expect(repeatsBulongguojiRow('out for delivery', 'out for delivery, expected delivery by 9:00pm')).toBe(false);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseBulongguojiTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${BULONGGUOJI_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseBulongguojiPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BL00', `${NUMBER},${UNKNOWN}`]) {
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
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'false', message: '系统繁忙' }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('maps every wording it lists, whatever the kind code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'bulongguoji', providerCode: 'USA', description: 'InTransit_CustomsProcessing' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'bulongguoji', description: 'Delivered, Parcel Locker' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
