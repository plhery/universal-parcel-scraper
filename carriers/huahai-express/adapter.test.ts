import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HuahaiTracker } from './adapter.js';
import { HUAHAI_ORIGIN, huahaiClock, parseHuahaiPage, parseHuahaiTrack, repeatsHuahaiRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json, which the fixtures answer, and a string in no shape the tracker issues.
const USPS_NUMBER = 'TRF0116800919270';
const UNIUNI_NUMBER = 'TRF0116800428704';
const UNKNOWN = 'ZZQX00000000000';
// The lookup's moment, after the fixtures' newest rows.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (content: string, location = '', clock = '2026-05-12 19:21:00') => ({ clock, content, location, code: '' });

describe('Huahai Express numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['Huahai Express', 'HuaHai Express', '花海供应链', '杭州花海供应链管理有限公司', 'Hangzhou Huahai Supply Chain Management']) {
      expect(carrierIdFromName(name), name).toBe('huahai-express');
    }
  });

  it('leaves the number to detection and reads it out of a link to its tracker', () => {
    expect(detectCarrierMatch(USPS_NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://119.45.241.73:8082/trackIndex.htm?documentCode=${USPS_NUMBER}`))
      .toMatchObject({ trackingNumber: USPS_NUMBER, carrier: 'huahai-express' });
  });
});

describe('Huahai Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered-usps')));
    await expect(new HuahaiTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${USPS_NUMBER.toLowerCase()} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HUAHAI_ORIGIN}/selectTrack.htm?documentCode=${USPS_NUMBER}`);
    expect(HUAHAI_ORIGIN).toBe('http://119.45.241.73:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'huahai-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads a parcel USPS delivered in San Diego, the line’s rows on Beijing’s clock until the landing and USPS’s copies once each', () => {
    const result = parseHuahaiTrack(fixture('delivered-usps'), USPS_NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-05-22T10:16:00',
      service_name: '美国超级经济优选小包-服装', destination_country: 'US',
    });
    expect(result.last_status_text).toMatch(/^Delivered, Front Door\/Porch -> Your item was delivered/);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    // The platform's custom track row, written in the same second as its own clock two hours after the departure, is held back.
    expect(result.planned_events).toEqual([expect.objectContaining({ time: '2026-05-08T18:54:09+08:00', description: 'The shipment is being transshipped via the hub' })]);
    const events = result.events!;
    expect(events).toHaveLength(29);
    const at = (description: string) => events.filter((event) => event.description === description).map((event) => event.time ?? event.local_time);
    // Read on Beijing's clock, the flight that left at 20:02 would land at 22:26 the same evening.
    expect(at('International flight has departed')).toEqual(['2026-05-11T20:02:00+08:00']);
    expect(at('International flight has arrived')).toEqual(['2026-05-11T22:26:00']);
    expect(at('Clearance processing completed - Import')).toEqual(['2026-05-12T19:21:00']);
    expect(at('Goods leaving the operation center')).toEqual(['2026-05-08T16:54:09+08:00']);
    // Each USPS scan the tracker lists twice, its headline alone and with USPS's sentence, stays once with the sentence.
    expect(at('Arrived at USPS Facility')).toEqual([]);
    expect(at('Out for Delivery')).toEqual([]);
    expect(events.filter((event) => event.description?.startsWith('Arrived at USPS Facility -> ')).map((event) => event.local_time))
      .toEqual(['2026-05-22T05:12:00', '2026-05-21T01:11:00']);
    expect(events.filter((event) => event.time).every((event) => event.time!.endsWith('+08:00'))).toBe(true);
    expect(events.every((event) => event.stage)).toBe(true);
    expect(events.at(-1)).toMatchObject({ description: 'The electronic information of the goods has been received', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/GSP-|signperson|customer_code/i);
  });

  it('reads a parcel UniUni delivered, with UniUni’s order row after the hand-over as movement', () => {
    const result = parseHuahaiTrack(fixture('delivered-uniuni'), UNIUNI_NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered. (Recipient\'s front door)' });
    const events = result.events!;
    expect(events.map((event) => [event.time ?? event.local_time, event.description, event.stage]).slice(6, 11)).toEqual([
      ['2025-11-12T15:31:00', 'Gateway transit in', 'in_transit'],
      ['2025-11-11T10:49:00', 'Order received', 'in_transit'],
      ['2025-11-10T18:20:00', 'Arrived at facility', 'in_transit'],
      ['2025-11-10T17:40:00', 'Delivered to local carrier', 'in_transit'],
      ['2025-11-09T22:42:00', 'Clearance processing completed - Import', 'in_transit'],
    ]);
    expect(events.at(-2)).toMatchObject({ time: '2025-11-07T11:30:09+08:00', description: 'parcel arrived at exchange office', stage: 'accepted', provider_code: 'ARRIVAL' });
  });

  it('reads a row’s clock by its place and the flight’s landing', () => {
    const landing = row('International flight has arrived', '', '2026-05-11 22:26:00');
    const rows = [row('International flight has departed', '', '2026-05-11 20:02:00'), landing];
    expect(huahaiClock(rows[0]!, rows)).toBe('platform');
    expect(huahaiClock(landing, rows)).toBe('wall');
    expect(huahaiClock(row('Clearance processing completed - Import'), rows)).toBe('wall');
    expect(huahaiClock(row('Goods leaving the operation center', 'Yiwu', '2026-05-08 16:54:09'), rows)).toBe('platform');
    // Rows placed in the United States, and GOFO's, keep their wall clocks before any landing row.
    expect(huahaiClock(row('Arrived at facility', 'US'), [])).toBe('wall');
    expect(huahaiClock(row('The shipment is being transshipped via the hub', 'CN'), [])).toBe('platform');
    expect(huahaiClock(row('Arrived at GOFO Regional Hub', 'Melrose Park, IL'), [])).toBe('wall');
    expect(huahaiClock(row('Shipping Label Created'), [])).toBe('wall');
    // The line through Korea lands at Incheon.
    const korea = row('The goods arrived at the airport in South Korea', '', '2025-06-10 12:18:00');
    expect(huahaiClock(row('The goods are being cleared through customs', '', '2025-06-12 18:27:52'), [korea])).toBe('wall');
  });

  it('dates the rows it copies from GOFO on GOFO’s clocks', () => {
    const reply = fixture('delivered-uniuni');
    const [record] = reply[0].data;
    const base = record.trackDetails.at(-1);
    record.trackDetails = [
      { ...base, track_date: '2026-01-12 20:42:00', track_createdate: '2026-01-13 16:56:08', track_location: 'Melrose Park, IL', track_content: 'Arrived at GOFO Regional Hub' },
      ...record.trackDetails.slice(-4),
    ];
    const events = parseHuahaiTrack(reply, UNIUNI_NUMBER, READ_AT)!.events!;
    expect(events[0]).toMatchObject({ time: '2026-01-12T20:42:00-06:00', time_zone: 'America/Chicago', location: 'Melrose Park, IL', stage: 'in_transit' });
  });

  it('folds a partner’s headline into its fuller copy of the same stage', () => {
    expect(repeatsHuahaiRow('Arrived at USPS Facility', 'Arrived at USPS Facility -> Your item arrived at our USPS facility')).toBe(true);
    expect(repeatsHuahaiRow('Out for Delivery', 'Out for Delivery, Expected Delivery by 9:00pm')).toBe(true);
    expect(repeatsHuahaiRow('Delivered', 'Delivered, Front Door/Porch')).toBe(true);
    expect(repeatsHuahaiRow('In Transit to Next Facility', 'In Transit, Arriving On Time')).toBe(false);
    expect(repeatsHuahaiRow('Out for Delivery', 'Out for Delivery Rescheduled, Notice Left')).toBe(false);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHuahaiTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${HUAHAI_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHuahaiPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered-usps')));
    await expect(adapter(environment(known)).recognize!(USPS_NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TRF', `${USPS_NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: USPS_NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: USPS_NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: USPS_NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'huahai-express', description: 'No Access to Delivery Location' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });
});
