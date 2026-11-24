import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EdPostTracker } from './adapter.js';
import { ED_POST_ORIGIN, edPostClock, parseEdPostPage, parseEdPostTrack, splitEdPostRow } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

// Public samples from a tracking directory's Yide International page, and an invented number.
const GOFO_LINE = 'YDPOZ0000265145YQ';
const DHL_LINE = 'YDPOZ0000265735YQ';
const UNKNOWN = 'YDPOZ0000000000YQ';
const GOFO = 'GFNL26317108953804';
const DHL = '00340435065309575122';
// The lookup's moment, after the fixtures' newest rows.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ED POST numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(GOFO_LINE)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    for (const link of [`http://www.666post.com:8082/trackIndex.htm?documentCode=${GOFO_LINE}`,
      `http://www.666post.com/sz56t/trackIndex.htm?documentCode=${GOFO_LINE}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: GOFO_LINE, carrier: 'ed-post' });
    }
  });
});

describe('ED POST tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('landed')));
    await expect(new EdPostTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(GOFO_LINE.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'in_transit', delivery_carrier: 'gofo-nl' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ED_POST_ORIGIN}/selectTrack.htm?documentCode=${GOFO_LINE}`);
    expect(ED_POST_ORIGIN).toBe('http://www.666post.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(init?.headers).not.toHaveProperty('auth');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'ed-post', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to GOFO in the Netherlands and keeps GOFO’s copied row on its wall clock', () => {
    const result = parseEdPostTrack(fixture('landed'), GOFO_LINE, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The flight has landed and will be handed over to the warehouse after customs clearance',
      last_update: '2026-11-23T14:58:41+08:00', destination_country: 'NL', delivery_carrier: 'gofo-nl', delivery_tracking_number: GOFO,
    });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events!.map(({ time, local_time, location, description, stage }) => [time ?? local_time, location, description, stage])).toEqual([
      ['2026-11-23T14:58:41+08:00', undefined, 'The flight has landed and will be handed over to the warehouse after customs clearance', 'in_transit'],
      ['2026-11-23T10:30:39+08:00', undefined, 'Departed from airport of Origin', 'in_transit'],
      ['2026-11-22T21:11:48+08:00', undefined, 'Estimated flight departure time (ETD: 11：23)', 'in_transit'],
      ['2026-11-20T05:06:05+08:00', '深圳', 'Departed the operations centre', 'in_transit'],
      ['2026-11-13T11:53:00+08:00', undefined, 'Package details received', 'registered'],
      // GOFO's label row, seven hours before the registration on Amsterdam's clock: no instant is invented for it.
      ['2026-11-13T04:53:02', undefined, 'Shipment not yet received or processed', 'registered'],
    ]);
    // The booked flight decides nothing.
    expect(result.events![2]).toMatchObject({ stage_source: 'none' });
    expect(result.events![5]).not.toHaveProperty('time');
    expect(result.planned_events).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['14375181746516', '61756847']) expect(text, value).not.toContain(value);
  });

  it('hands the parcel to DHL in Germany, drops the status glued to DHL’s rows and dates them on DHL’s clock', () => {
    const result = parseEdPostTrack(fixture('dhl'), DHL_LINE, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', last_status_text: 'Sent to warehouse, waiting for scanning', last_update: '2026-11-23T18:33:32+08:00',
      destination_country: 'DE', delivery_carrier: 'dhl', delivery_tracking_number: DHL,
    });
    const rows = result.events!.filter(({ time_zone }) => time_zone === 'Europe/Berlin');
    expect(rows.map(({ time, description, stage }) => [time, description, stage])).toEqual([
      ['2026-11-14T01:19:27+01:00', 'The shipment is in transit to DHL', 'in_transit'],
      ['2026-11-13T12:21:45+01:00', 'A preferred neighbour was designated as a reception option for this shipment.', 'registered'],
      ['2026-11-13T12:13:28+01:00', 'The instruction data for this shipment have been provided by the sender to DHL electronically', 'registered'],
    ]);
    expect(rows[1]).toMatchObject({ stage_source: 'none' });
    expect(result.events!.filter(({ description }) => /\Stransit$/.test(description ?? ''))).toEqual([]);
    // The platform's custom track row is a planned step, as on every tenant.
    expect(result.planned_events).toEqual([expect.objectContaining({ description: 'Out of warehouse, waiting for matching flight', location: 'CN' })]);
  });

  it('reads a delivery carrier’s copied row as a wall clock and the forwarder’s own on Beijing’s', () => {
    const clock = (content: string) => edPostClock({ clock: '2026-11-13 04:53:02', content, location: '', code: '' });
    expect(['Shipment not yet received or processed', 'The shipment is in transit to DHLtransit'].map(clock)).toEqual(['wall', 'wall']);
    expect(['Package?details?received', 'Departed from airport of Origin', '货物离开操作中心'].map(clock)).toEqual(Array(3).fill('platform'));
    expect(splitEdPostRow('The shipment is in transit to DHLtransit', '')).toEqual({ content: 'The shipment is in transit to DHL', location: '' });
    expect(splitEdPostRow('In transit', '')).toEqual({ content: 'In transit', location: '' });
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${ED_POST_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(parseEdPostTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    expect(() => parseEdPostPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('landed')));
    await expect(adapter(environment(known)).recognize!(GOFO_LINE)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YD00', `${GOFO_LINE},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: GOFO_LINE }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: GOFO_LINE }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('<html><body>维护中</body></html>')))).track({ number: GOFO_LINE }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: GOFO_LINE }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'false', message: '系统繁忙' }])))).track({ number: GOFO_LINE }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('maps every wording it lists, the booked flight whatever its day, and leaves the notices without a stage', () => {
    for (const entry of ENTRIES) {
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage ?? undefined);
    }
    expect(statusMapAnswer({ carrier: 'ed-post', description: 'Estimated flight departure time (ETD: 12：01)' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'ed-post', description: '货物离开操作中心' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'ed-post', description: 'Departed the operations centre' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
