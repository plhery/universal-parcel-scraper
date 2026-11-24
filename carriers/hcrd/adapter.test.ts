import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HcrdTracker } from './adapter.js';
import { HCRD_ORIGIN, hcrdClock, parseHcrdPage, parseHcrdTrack, splitHcrdRow } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

// Public samples from a tracking directory's HCRD page, and an invented number.
const DELIVERED = 'HC0003013565RD';
const IN_TRANSIT = 'HC0003010989RD';
const UNKNOWN = 'HC0000000000RD';
const GOFO = 'GFUS01084400785794';
// The lookup's moment, after the fixtures' newest rows.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The delivered fixture without the rows `drop` picks. */
const without = (drop: (row: { track_content: string; track_location: string }) => boolean): Reply => {
  const payload = fixture('delivered');
  const record = payload[0].data[0];
  record.trackDetails = record.trackDetails.filter((row: { track_content: string; track_location: string }) => !drop(row));
  return payload;
};

describe('HCRD numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://www.xchcrd.com:8082/trackIndex.htm?documentCode=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'hcrd' });
  });
});

describe('HCRD tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new HcrdTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(DELIVERED.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'gofo' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HCRD_ORIGIN}/selectTrack.htm?documentCode=${DELIVERED}`);
    expect(HCRD_ORIGIN).toBe('http://www.xchcrd.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'hcrd', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads GOFO’s scans once each, on Beijing’s clock, hands the parcel to GOFO and names the scripted rows as planned', () => {
    const result = parseHcrdTrack(fixture('delivered'), DELIVERED, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered, Door/Yard.',
      last_update: '2026-11-25T04:40:45+08:00', service_name: 'HC-FEDEX4', destination_country: 'US',
      delivery_carrier: 'gofo', delivery_tracking_number: GOFO,
    });
    // GOFO dates the delivery 15:40:45 Eastern; the copies under the bare station name, on its wall clock, go.
    expect(result.events!.map(({ time, location, description, stage }) => [time, location, description, stage])).toEqual([
      ['2026-11-25T04:40:45+08:00', 'Union, NJ', 'Delivered, Door/Yard.', 'delivered'],
      ['2026-11-24T23:21:58+08:00', 'Perth Amboy, NJ', 'Out for Delivery', 'out_for_delivery'],
      ['2026-11-24T23:11:58+08:00', 'Perth Amboy, NJ', 'Arrived at GOFO Delivery Station', 'in_transit'],
      ['2026-11-23T02:20:20+08:00', 'Carteret, NJ', 'Loaded on Vehicle', 'in_transit'],
      ['2026-11-22T13:31:28+08:00', 'Carteret, NJ', 'Arrived at GOFO Regional Hub', 'in_transit'],
      ['2026-11-20T20:12:03+08:00', 'United States', `in transit via GOFO tracking number:${GOFO}`, 'in_transit'],
    ]);
    // The custom track product's rows, from the pickup in China to the last US facility, are named, not kept as scans.
    expect(result.written_ahead).toHaveLength(13);
    expect(result.planned_events).toHaveLength(13);
    expect(result.planned_events![0]).toMatchObject({ time: '2026-11-19T01:35:00+08:00', description: 'Pickup Scan', location: 'China' });
    expect(result.planned_events!.at(-1)).toMatchObject({ description: 'Processing at Facility', location: 'Monroe Township, NJ, United States' });
    expect(result.canonical_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['892631910616802', 'cs@mail.gofo.com', '949', '"OK.']) expect(text, value).not.toContain(value);
  });

  it('keeps a GOFO scan listed only on its station’s wall clock, dated on GOFO’s clock for a station GOFO names', () => {
    // The hub scans' copies under the town and state, on Beijing's clock, are not written yet.
    const result = parseHcrdTrack(without((row) => row.track_location === 'Carteret, NJ'), DELIVERED, READ_AT)!;
    expect(result.events!.filter(({ location }) => location === 'Carteret')).toEqual([
      expect.objectContaining({ description: 'Loaded on Vehicle', time: '2026-11-22T13:20:20-05:00', time_zone: 'America/New_York', time_zone_basis: 'place' }),
      expect.objectContaining({ description: 'Arrived at GOFO Regional Hub', time: '2026-11-22T00:31:28-05:00', time_zone: 'America/New_York' }),
    ]);
    // A delivery round GOFO names after the town keeps its wall clock alone.
    const round = parseHcrdTrack(without((row) => row.track_location === 'Perth Amboy, NJ'), DELIVERED, READ_AT)!;
    expect(round.events!.find(({ location }) => location === 'Union')).toMatchObject({ local_time: '2026-11-24T10:21:58', description: 'Out for Delivery' });
    expect(round.events!.find(({ location }) => location === 'Union')).not.toHaveProperty('time');
  });

  it('reads a bare station name as a wall clock, and a country, a town with its state or a scripted row on Beijing’s', () => {
    const clock = (location: string, code = '') => hcrdClock({ clock: '2026-11-24 10:21:58', content: 'Out for Delivery', location, code });
    expect(['Union', 'Carteret'].map((place) => clock(place))).toEqual(['wall', 'wall']);
    expect(['US', 'United States', 'Perth Amboy, NJ', '', 'China'].map((place) => clock(place))).toEqual(Array(5).fill('platform'));
    expect(clock('China', 'CO_C_CR')).toBe('platform');
    expect(splitHcrdRow('Delivered, Door/Yard. For Delivery Issues & Tracking Support, Contact GOFO at +1 000 000-0000 or help@example.com', 'Union, NJ'))
      .toEqual({ content: 'Delivered, Door/Yard.', location: 'Union, NJ' });
  });

  it('keeps the forwarder’s own row after the scripted ones while the parcel waits for GOFO', () => {
    const result = parseHcrdTrack(fixture('in-transit'), IN_TRANSIT, READ_AT)!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-11-23T21:19:39+08:00' });
    expect(result.events).toEqual([expect.objectContaining({ description: 'In transit', location: 'US', time: '2026-11-23T21:19:39+08:00' })]);
    expect(result.planned_events).toHaveLength(13);
    expect(result.delivery_carrier ?? result.delivery_tracking_number).toBeUndefined();
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${HCRD_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(parseHcrdTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    expect(() => parseHcrdPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['HC00', `${DELIVERED},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('<html><body>维护中</body></html>')))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'false', message: '系统繁忙' }])))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('maps every wording it lists, the hand-over to GOFO whatever its number, and leaves the row naming FedEx without a stage', () => {
    for (const entry of ENTRIES) {
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage ?? undefined);
    }
    expect(statusMapAnswer({ carrier: 'hcrd', description: 'in transit via GOFO tracking number:GFUS01000000000000' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'hcrd', providerCode: 'CO_C_CR', description: 'Import Scan' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'hcrd', description: 'FedEx' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
