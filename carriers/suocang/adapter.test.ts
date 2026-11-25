import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SuocangTracker } from './adapter.js';
import { parseSuocangPage, parseSuocangTrack, SUOCANG_ORIGIN, suocangClock } from './parser.js';
import { isSuocangDhlGermanRow, isSuocangDhlRow, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's SUOCANG page, and a string in no shape the tracker issues.
const NUMBER = 'SC2026000211102';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('Suoexpress numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://42.193.237.14:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'suocang' });
  });
});

describe('Suoexpress tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new SuocangTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'DE', last_update: '2026-07-31T14:35:29+02:00' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SUOCANG_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(SUOCANG_ORIGIN).toBe('http://42.193.237.14:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'suocang', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the line’s rows on Beijing’s clock, DHL’s in its towns’ zone, and the script as planned steps', () => {
    const result = parseSuocangTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been successfully delivered', last_update: '2026-07-31T14:35:29+02:00',
      service_name: '所仓欧州特惠专线(化妆品)', destination_country: 'DE',
    });
    // The record holds no DHL number.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(9);
    expect(events[0]).toMatchObject({
      time: '2026-07-31T14:35:29+02:00', local_time: '2026-07-31T14:35:29', time_zone: 'Europe/Berlin', time_zone_basis: 'place',
      location: 'Hagen', stage: 'delivered',
    });
    expect(events[1]).toMatchObject({ description: 'Loaded to movement / tour vehicle', stage: 'in_transit', time: '2026-07-31T09:30:25+02:00' });
    // DHL's announcement, placed at the destination's code alone, is on DHL's German clock.
    expect(events.find(({ location }) => location === 'DE')).toMatchObject({
      time: '2026-07-18T04:50:10+02:00', time_zone: 'Europe/Berlin', time_zone_basis: 'carrier', stage: 'registered',
    });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2026-07-17T14:53:30+08:00', location: 'SZS', description: 'Arrived at origin facility', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2026-07-14T09:24:01+08:00', description: 'Order Received', stage: 'registered' });
    // The platform's custom track rows, from the warehouse to the clearance, are planned steps on Beijing's clock.
    expect(events.some(({ provider_code: code }) => code === 'CO_C_CR')).toBe(false);
    expect(result.planned_events?.map(({ description }) => description)).toEqual([
      'Shipment is in transit to next facility', 'Arrived at the origin international airport', 'Waiting for the flight',
      'International flight has departed', 'International flight has arrived', 'In clearance processing',
    ]);
    expect(result.planned_events?.[3]).toMatchObject({ time: '2026-07-21T04:09:04+08:00', stage: 'in_transit' });
    expect(result.written_ahead).toHaveLength(6);
  });

  it('reads a row copied from DHL as a wall clock and the line’s own on the platform’s', () => {
    expect([row('2026-07-31 14:35:29', 'The shipment has been successfully delivered', 'Hagen'),
      row('2026-07-31 09:30:25', 'Loaded to movement / tour vehicle', 'Hagen'),
      row('2026-07-18 04:50:10', 'The instruction data for this shipment have been provided by the sender to DHL electronically', 'DE'),
      row('2026-07-17 19:03:04', 'Departed from sort facility', 'SZS', 'SHIPMENT'), row('2026-07-17 07:39:56', 'Shipment information received')]
      .map(suocangClock)).toEqual(['wall', 'wall', 'wall', 'platform', 'platform']);
    expect(['The instruction data for this shipment have been provided by the sender to DHL electronically',
      'The shipment has been processed in the parcel center of origin'].every(isSuocangDhlGermanRow)).toBe(true);
    expect(isSuocangDhlGermanRow('The shipment has been processed in the destination parcel center')).toBe(false);
    expect(['Arrived at origin facility', 'Order Received', 'International flight has arrived'].some(isSuocangDhlRow)).toBe(false);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseSuocangTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${SUOCANG_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseSuocangPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SC20', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, whatever the row’s kind code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'suocang', providerCode: 'ARRIVAL', description: 'Arrived at origin facility' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'suocang', description: 'Loaded to movement / tour vehicle' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
