import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HjytTracker } from './adapter.js';
import { HJYT_ORIGIN, hjytClock, parseHjytPage, parseHjytTrack, splitHjytRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's HJYT page, iMile's waybill, and a number in a shape
// the tracker cannot hold.
const NUMBER = '6022725441176';
const UNKNOWN = 'ZZ0000000000ZZ';
// The forwarder's own waybill and the shipper's reference, which the record holds beside iMile's number.
const WAYBILL = 'SG73120250228190051650';
const REFERENCE = 'HB1513081SHY25022613';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('Hengjie Yutong numbers', () => {
  it('leaves the iMile waybill to detection and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('hjyt');
    expect(parseTrackingInput(`http://120.78.64.88:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'hjyt' });
  });
});

describe('Hengjie Yutong tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new HjytTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'AE' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HJYT_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(HJYT_ORIGIN).toBe('http://120.78.64.88:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'hjyt', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps the scans copied from iMile on their wall clocks and the warehouse’s on Beijing’s', () => {
    const result = parseHjytTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered,Your order has been delivered successfully.', last_update: null,
      last_update_local: '2025-03-14T19:53:22', service_name: 'D专线-阿联酋纯电', destination_country: 'AE',
    });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(14);
    expect(events.slice(0, 4).map(({ local_time: local, location, description, stage, time }) => [local, location, description, stage, time])).toEqual([
      ['2025-03-14T19:53:22', 'AUH DS', 'Delivered,Your order has been delivered successfully.', 'delivered', undefined],
      ['2025-03-14T03:40:43', 'AUH DS', 'Delivery,Our delivery associate is out for delivery.', 'out_for_delivery', undefined],
      ['2025-03-14T02:07:22', 'AUH DS', 'Delivery,Your order has arrived at 【AUH DS】', 'in_transit', undefined],
      ['2025-03-13T21:24:27', 'Dubai Center', 'In transit', 'in_transit', undefined],
    ]);
    // iMile's receipt at its Shenzhen centre is on iMile's clock in the Emirates too.
    expect(events.find(({ location, description }) => location === 'ShenZhen Center' && description === 'In transit'))
      .toMatchObject({ local_time: '2025-03-07T20:57:21' });
    expect(events.find(({ description }) => description === 'Received,【ShenZhen Center】Your order has been received.'))
      .toMatchObject({ local_time: '2025-03-03T16:06:42', stage: 'in_transit' });
    expect(events.find(({ provider_code: code }) => code === 'SHIPMENT'))
      .toMatchObject({ time: '2025-03-03T14:53:29+08:00', location: 'SHENZHEN', stage: 'in_transit' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2025-02-28T19:00:51+08:00', description: 'The Item is at the shippers warehouse', stage: 'accepted' });
    expect(events.find(({ description }) => description === 'Electronic information submitted by shipper'))
      .toMatchObject({ time: '2025-02-27T11:51:37+08:00', stage: 'registered' });
    expect(events.at(-1)).toMatchObject({ local_time: '2025-02-27T07:51:39', location: 'AE', stage: 'registered' });
    expect(result.planned_events ?? []).toEqual([]);
  });

  it('finds the record by the forwarder’s waybill and the shipper’s reference, with iMile’s number as its tracking number', () => {
    for (const number of [WAYBILL, REFERENCE]) {
      expect(parseHjytTrack(fixture('delivered'), number, READ_AT)).toMatchObject({ canonical_tracking_number: NUMBER, current_stage: 'delivered' });
    }
  });

  it('drops the place the tracker writes again ahead of iMile’s category, and reads a row by its kind code and place', () => {
    expect(splitHjytRow('AUH DS Delivered,Your order has been delivered successfully.', 'AUH DS'))
      .toEqual({ content: 'Delivered,Your order has been delivered successfully.', location: 'AUH DS' });
    expect(splitHjytRow('In transit', 'Dubai Center')).toEqual({ content: 'In transit', location: 'Dubai Center' });
    expect([row('2025-03-14 19:53:22', 'Delivered', 'AUH DS'), row('2025-03-11 01:10:00', 'In transit', 'AE'),
      row('2025-03-03 14:53:29', 'The item is ready for shipment', 'SHENZHEN', 'SHIPMENT'),
      row('2025-02-27 11:51:37', 'Electronic information submitted by shipper')].map(hjytClock))
      .toEqual(['wall', 'wall', 'platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHjytTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${HJYT_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHjytPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['60227', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, whatever iMile’s centre or station is called', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'hjyt', description: 'Delivery,Your order has arrived at 【DXB DS】' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'hjyt', providerCode: 'ARRIVAL', description: 'The Item is at the shippers warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
