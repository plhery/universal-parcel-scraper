import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ZxsyTracker } from './adapter.js';
import { parseZxsyPage, parseZxsyTrack, splitZxsyRow, ZXSY_ORIGIN, zxsyClock } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's ZXSY page, and an invented number.
const NUMBER = 'ZXSY00055475CN';
const UNKNOWN = 'ZXSY00000000CN';
const HELTHJEM = '00370724763452664998';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('ZXSY numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://www.zxsywl.cn:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'zxsy' });
  });
});

describe('ZXSY tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new ZxsyTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'helthjem' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ZXSY_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(ZXSY_ORIGIN).toBe('http://www.zxsywl.cn:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'zxsy', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to Helthjem and keeps the scans copied in Norway on their wall clocks', () => {
    const result = parseZxsyTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel delivered', last_update: null, last_update_local: '2026-06-12T03:10:46',
      service_name: 'DH甄兴盛越线上欧洲专线', destination_country: 'NO', delivery_carrier: 'helthjem', delivery_tracking_number: HELTHJEM,
    });
    expect(result.canonical_tracking_number).toBeUndefined();
    const events = result.events!;
    expect(events).toHaveLength(26);
    // Helthjem's scans keep the wall clock Helthjem's own tracker gives them; the bare status codes beside them go.
    expect(events.slice(0, 5).map(({ local_time: local, location, description, stage, time }) => [local, location, description, stage, time])).toEqual([
      ['2026-06-12T03:10:46', 'GJ VIK', 'Parcel delivered', 'delivered', undefined],
      ['2026-06-12T00:59:01', 'Helthjem Distribusjon Gj vik', 'Parcel activated', 'in_transit', undefined],
      ['2026-06-12T00:57:04', 'Gj vik', 'Parcel is being loaded for transport', 'in_transit', undefined],
      ['2026-06-11T17:24:26', 'Vestby', 'Parcel has been received', 'in_transit', undefined],
      ['2026-06-11T17:24:06', 'VestbySorter', 'Parcel is being loaded for transport', 'in_transit', undefined],
    ]);
    expect(events.map(({ description }) => description)).not.toEqual(expect.arrayContaining(['DELIVERED', 'INFO', 'Delivered']));
    expect(events.find(({ location }) => location === 'Oslo Airport, Norway')).toMatchObject({ local_time: '2026-06-10T21:24:16' });
    // The line's own rows, placed at a country or nowhere, are on Beijing's clock.
    expect(events.find(({ description }) => description === 'Customs clearance completed'))
      .toMatchObject({ time: '2026-06-10T19:24:16+08:00', location: 'Norway' });
    expect(events.find(({ location }) => location === 'SHENZHEN')).toMatchObject({ time: '2026-06-01T21:39:33+08:00' });
    // The booked flight's days decide nothing.
    for (const wording of ['Flight ETA Jun 6.', 'Flight ETD Jun 4.']) {
      expect(events.find(({ description }) => description === wording)).toMatchObject({ stage: 'in_transit', stage_source: 'none' });
    }
    expect(events.find(({ description }) => description === 'The flight has departed Jun 5.'))
      .toMatchObject({ time: '2026-06-05T10:12:01+08:00', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events.find(({ provider_code: code }) => code === 'ARRIVAL'))
      .toMatchObject({ time: '2026-05-31T15:13:43+08:00', location: '福建', description: 'Arrived at the receiving point', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2026-05-31T09:39:15+08:00', description: 'Shipment information received', stage: 'registered' });
    expect(result.planned_events ?? []).toEqual([]);
  });

  it('drops a bare status code and reads a town abroad as a wall clock from the first row placed abroad on', () => {
    expect(['DELIVERED', 'ITEM_AT_DELIVERY_DEPOT', 'INFO'].map((code) => splitZxsyRow(code, ''))).toEqual(Array(3).fill({ content: '', location: '' }));
    expect(splitZxsyRow('Parcel delivered', 'GJ?VIK')).toEqual({ content: 'Parcel delivered', location: 'GJ?VIK' });
    const rows = [row('2026-06-12 03:10:46', 'Parcel delivered', 'GJ?VIK'), row('2026-06-11 09:00:49', 'In transit', 'NO'),
      row('2026-06-10 21:24:16', 'Released by customs', 'Oslo Airport, Norway'), row('2026-06-05 10:12:20', 'Flight ETA Jun 6.', 'NO'),
      row('2026-06-01 21:39:33', 'Shipment departed from facility', 'SHENZHEN'), row('2026-05-31 16:30:07', '货物离开操作中心', '福建', 'SHIPMENT'),
      row('2026-05-31 09:39:15', 'Shipment information received')];
    expect(rows.map((one) => zxsyClock(one, rows))).toEqual(['wall', 'platform', 'wall', 'platform', 'platform', 'platform', 'platform']);
    const china = [row('2026-06-01 21:39:33', 'Shipment departed from facility', 'SHENZHEN'), row('2026-06-02 10:28:11', 'In transit to airport.', 'CN')];
    expect(china.map((one) => zxsyClock(one, china))).toEqual(['platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseZxsyTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${ZXSY_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseZxsyPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZX00', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, the flight whatever its day, and leaves the booked flight’s days without a stage', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage ?? undefined);
    }
    expect(statusMapAnswer({ carrier: 'zxsy', description: 'Flight ETD Dec 1.' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'zxsy', description: 'The flight has departed Dec 2.' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'zxsy', providerCode: 'ARRIVAL', description: '到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'zxsy', description: 'Parcel delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
