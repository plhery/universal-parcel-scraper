import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MeitongdaTracker } from './adapter.js';
import { MEITONGDA_ORIGIN, meitongdaClock, parseMeitongdaPage, parseMeitongdaTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's MEITONGDA page, and a string in no shape the tracker issues.
const NUMBER = 'MTD00000000001841437';
const UNKNOWN = 'ZZ0000000000ZZ';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MEITONGDA numbers', () => {
  it('leaves the number to detection and reads it out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://119.91.196.60:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'meitongda' });
  });
});

describe('MEITONGDA tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new MeitongdaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'GB' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MEITONGDA_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(MEITONGDA_ORIGIN).toBe('http://119.91.196.60:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'meitongda', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads a parcel delivered in Belfast, the rows abroad on their wall clocks and the line’s on Beijing’s, with no onward carrier', () => {
    const result = parseMeitongdaTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-06-13T10:30:30',
      service_name: 'MT68 Europe Sensitive Line', destination_country: 'GB',
    });
    // The record names no channel, transfer number or other carrier.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.planned_events ?? []).toEqual([]);
    const events = result.events!;
    expect(events.every((event) => !event.provider_code)).toBe(true);
    // The rows placed abroad keep their station's clock: on Beijing's, the delivery office would go out at 01:38 in
    // Belfast. The rows placed nowhere, the order's and the line's in China, are on Beijing's.
    expect(events.map(({ local_time: local, time, location, description, stage }) => [local ?? time, location, description, stage])).toEqual([
      ['2026-06-13T10:30:30', 'BELFAST WEST DO', 'Delivered', 'delivered'],
      ['2026-06-13T08:38:50', 'BELFAST WEST DO', 'Out for Delivery', 'out_for_delivery'],
      ['2026-06-12T15:16:45', 'NORTHERN IRELAND MC', 'Arrived processin center', 'in_transit'],
      ['2026-06-10T23:26:22', 'PRINCESS ROYAL PARCEL HUB', 'Arrived processin center', 'in_transit'],
      ['2026-06-10T17:20:00', 'LHR', 'The packa e has been transferred to the service provider', 'in_transit'],
      ['2026-06-10T13:24:00', 'LHR', 'The packa e has been cleared throu h customs', 'in_transit'],
      ['2026-06-09T20:46:00', 'LHR', 'The packa e is bein submitted for customs clearance', 'customs'],
      ['2026-06-09T16:59:00', 'LHR', 'Arrived at destination airport', 'in_transit'],
      ['2026-06-08T00:35:00+08:00', undefined, 'Next stop, airport of destination', 'in_transit'],
      ['2026-06-07T21:31:00+08:00', undefined, 'Hand over to airline', 'in_transit'],
      ['2026-06-06T20:23:00+08:00', undefined, 'Export customs declaration completed', 'in_transit'],
      ['2026-06-06T06:57:16+08:00', undefined, 'Leavin Scan', 'in_transit'],
      ['2026-06-05T23:10:57+08:00', undefined, 'Packa ed', 'in_transit'],
      ['2026-06-05T03:33:04+08:00', undefined, 'Barcode scannin', 'accepted'],
      ['2026-06-04T19:51:41+08:00', undefined, 'Forecast has been received', 'registered'],
      ['2026-06-03T11:15:53+08:00', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(events.filter((event) => event.location).every((event) => event.local_time && !event.time)).toBe(true);
    // The platform's own clock says when it wrote each row.
    expect(events[0]).toMatchObject({ written_at: '2026-06-15T11:46:17+08:00' });
    expect(JSON.stringify(result)).not.toMatch(/XM0000000000|0000000000000000000|signperson/i);
  });

  it('reads a row’s clock by its place', () => {
    const row = (location: string) => ({ clock: '2026-06-13 10:30:30', content: 'Delivered', location, code: '' });
    expect(['BELFAST WEST DO', 'LHR', '', '  '].map((location) => meitongdaClock(row(location)))).toEqual(['wall', 'wall', 'platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseMeitongdaTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${MEITONGDA_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseMeitongdaPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MTD', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'meitongda', description: 'The packa e is bein submitted for customs clearance' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
  });
});
