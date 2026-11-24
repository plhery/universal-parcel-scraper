import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, VyangTracker } from './adapter.js';
import { parseVyangPage, parseVyangTrack, VYANG_ORIGIN, vyangClock } from './parser.js';
import { isVyangDhlRow, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's VYANG page, and an invented number.
const NUMBER = 'VY000010380781YQ';
const UNKNOWN = 'VY000000000000YQ';
const DHL = '00340434525234254703';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('VYANG numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://43.136.110.132:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'vyang' });
  });
});

describe('VYANG tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new VyangTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'dhl' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${VYANG_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(VYANG_ORIGIN).toBe('http://43.136.110.132:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'vyang', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the line’s rows in China on Beijing’s clock, those from the landing on as wall clocks, and DHL’s in its towns’ zone', () => {
    const result = parseVyangTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been successfully delivered', last_update: '2026-05-27T12:20:04+02:00',
      destination_country: 'DE', delivery_carrier: 'dhl', delivery_tracking_number: DHL,
    });
    const events = result.events!;
    expect(events).toHaveLength(23);
    expect(events[0]).toMatchObject({
      time: '2026-05-27T12:20:04+02:00', local_time: '2026-05-27T12:20:04', time_zone: 'Europe/Berlin', time_zone_basis: 'place',
      location: 'Siegen', stage: 'delivered',
    });
    expect(events.find(({ location }) => location === 'Fulda')).toMatchObject({ time: '2026-05-23T11:23:00+02:00' });
    // Liège's rows and the landing keep their wall clock alone: the tracker states no zone.
    const landing = events.find(({ description }) => description === 'International flight has arrived')!;
    expect(landing).toMatchObject({ local_time: '2026-05-21T22:17:00', location: 'BE' });
    expect(landing).not.toHaveProperty('time');
    expect(events.filter(({ location }) => location?.startsWith('LIEGE')).every((event) => !event.time && event.local_time)).toBe(true);
    expect(events.find(({ description }) => description === 'International flight has departed')).toMatchObject({ time: '2026-05-21T14:08:00+08:00' });
    expect(events.find(({ provider_code }) => provider_code === 'ARRIVAL'))
      .toMatchObject({ time: '2026-05-18T14:27:15+08:00', location: 'DONGGUAN', description: 'Shipment arrived', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2026-05-18T04:07:08+08:00', stage: 'registered' });
    expect(result.planned_events ?? []).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SOG202605180407057822');
  });

  it('reads a row placed abroad, any row from then on and any DHL row as a wall clock', () => {
    const rows = [row('2026-05-21 22:17:00', 'International flight has arrived', 'BE'), row('2026-05-21 14:08:00', 'International flight has departed'),
      row('2026-05-18 14:27:15', 'Shipment arrived', 'DONGGUAN', 'ARRIVAL'), row('2026-05-19 11:38:28', 'Arrived', 'Mainland China, CN'),
      row('2026-05-23 11:23:00', 'Sorted', 'Fulda')];
    expect(rows.map((one) => vyangClock(one, rows))).toEqual(['wall', 'platform', 'platform', 'platform', 'wall']);
    const china = [row('2026-05-18 14:27:15', 'Shipment arrived', 'DONGGUAN', 'ARRIVAL'), row('2026-05-19 11:38:28', 'Arrived', 'Mainland China, CN')];
    expect(china.map((one) => vyangClock(one, china))).toEqual(['platform', 'platform']);
    const dhl = row('2026-05-23 11:23:00', 'The shipment has been processed in the destination parcel center', 'Fulda');
    expect(vyangClock(dhl, [dhl])).toBe('wall');
    expect(['Loaded to movement / tour vehicle', 'The shipment has been successfully delivered'].every(isVyangDhlRow)).toBe(true);
    expect(['Shipment arrived', 'Delivered to local carrier', 'The country of origin commences customs declaration.'].some(isVyangDhlRow)).toBe(false);
  });

  it('reads the echo of an unknown number as no row, which the page settles as not found', async () => {
    expect(parseVyangTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${VYANG_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseVyangPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['VY00', `${NUMBER},${UNKNOWN}`]) {
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
    expect(statusMapAnswer({ carrier: 'vyang', providerCode: 'ARRIVAL', description: 'Shipment arrived' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'vyang', description: 'Delivered to local carrier' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
