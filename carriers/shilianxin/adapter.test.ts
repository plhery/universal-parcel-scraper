import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ShilianxinTracker } from './adapter.js';
import { parseShilianxinPage, parseShilianxinTrack, SHILIANXIN_ORIGIN, splitShilianxinRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples from a tracking directory's Shilianxin page, of the US and the Royal Mail lines, and an invented number.
const NUMBER = 'SLX200119352CN';
const NUMBER_GB = 'SLX200058555GB';
const UNKNOWN = 'SLX000000000CN';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shilianxin numbers', () => {
  it('claims no number by its shape, not even for the Korean SLX, and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://47.108.154.213:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'shilianxin' });
  });
});

describe('Shilianxin tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new ShilianxinTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHILIANXIN_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(SHILIANXIN_ORIGIN).toBe('http://47.108.154.213:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'shilianxin', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the forwarder’s rows in English on Beijing’s clock and USPS’s copies on their wall clocks', () => {
    const result = parseShilianxinTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Front Door/Porch', last_update: null, last_update_local: '2025-06-30T16:46:00',
      service_name: '美国专线小包-标快', destination_country: 'US',
    });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(24);
    // USPS's scans keep their wall clock, a midnight one its day alone, and their place without its ZIP code.
    expect(events[0]).toMatchObject({ local_time: '2025-06-30T16:46:00', location: 'NORTH CANTON, OH', stage: 'delivered' });
    expect(events[0]).not.toHaveProperty('time');
    expect(events.find(({ description }) => description === 'In Transit to Next Facility')).toMatchObject({ local_time: '2025-06-28' });
    // A row worded in both languages shows its English half, on Beijing's clock to the minute.
    expect(events.find(({ description }) => description === 'Flight arrived'))
      .toMatchObject({ time: '2025-06-24T22:05:00+08:00', location: 'US', stage: 'in_transit' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2025-06-12T14:37:43+08:00', location: '深圳', description: 'Arrived at the receiving point', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2025-06-10T19:35:02+08:00', description: 'Shipment information received', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/；|00000/);
    expect(result.planned_events ?? []).toEqual([]);
  });

  it('reads the Royal Mail line: its custom track as planned steps, and Royal Mail’s copies on the platform’s clock', () => {
    const result = parseShilianxinTrack(fixture('delivered-gb'), NUMBER_GB, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-07-28T19:06:43+08:00', service_name: 'GB皇邮专线-F', destination_country: 'GB',
    });
    // Royal Mail's copies, written within the hour of their clock read on Beijing's, are on the platform's clock.
    expect(result.events!.map(({ time, description, stage, stage_source: source }) => [time, description, stage, source])).toEqual([
      ['2026-07-28T19:06:43+08:00', 'Delivered', 'delivered', 'carrier_map'],
      ['2026-07-28T15:37:55+08:00', 'Out for Delivery', 'out_for_delivery', 'carrier_map'],
      ['2026-07-28T12:44:44+08:00', 'Shipment Received in Depot', 'in_transit', 'carrier_map'],
      ['2026-07-27T09:10:00+08:00', 'Shipment Received in Depot', 'in_transit', 'carrier_map'],
      ['2026-07-17T10:25:17+08:00', 'Arrived at the receiving point', 'accepted', 'carrier_map'],
      ['2026-07-15T18:05:37+08:00', 'Shipment information received', 'registered', 'carrier_map'],
    ]);
    // The line's rows from the warehouse to the import clearance come from the platform's custom track product.
    const planned = result.planned_events!;
    expect(planned).toHaveLength(13);
    expect(planned.slice(-3).map(({ description, stage }) => [description, stage])).toEqual([
      ['Destination airport sorting and unpacking in progress', 'in_transit'],
      ['Destination airport dismantling completed, awaiting customs clearance', 'customs'],
      ['Destination country customs clearance', 'in_transit'],
    ]);
  });

  it('keeps the English half of a row worded in both languages', () => {
    expect(splitShilianxinRow('飞行离开 ；Flight Departed', 'CN')).toEqual({ content: 'Flight Departed', location: 'CN' });
    expect(splitShilianxinRow('到达收货点', '深圳')).toEqual({ content: '到达收货点', location: '深圳' });
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseShilianxinTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${SHILIANXIN_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseShilianxinPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SL00', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, whatever the warehouse’s kind code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'shilianxin', providerCode: 'ARRIVAL', description: '到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'shilianxin', description: 'Flight Departed' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
