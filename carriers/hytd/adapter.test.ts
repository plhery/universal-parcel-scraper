import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HytdTracker } from './adapter.js';
import { HYTD_ORIGIN, hytdClock, parseHytdPage, parseHytdTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's HYTD page, and an invented number.
const NUMBER = 'HY000000301953TD';
const UNKNOWN = 'HY000000000000TD';
// The delivering carrier's number the record holds, of a carrier it does not name.
const DOWNSTREAM = 'ZP13137896501';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('HYTD Express numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://159.75.218.197:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'hytd' });
  });
});

describe('HYTD Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new HytdTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HYTD_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(HYTD_ORIGIN).toBe('http://159.75.218.197:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'hytd', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads USPS’s copies at a town or facility on their wall clocks and the line’s rows on Beijing’s', () => {
    const result = parseHytdTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Package delivered by U.S. Postal Service to addressee', last_update: null,
      last_update_local: '2026-06-16T11:10:00', service_name: 'HY美国普货包税(白名单)', destination_country: 'US',
      delivery_tracking_number: DOWNSTREAM,
    });
    // The record does not say whose number it is, and it is not HYTD's own.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.canonical_tracking_number).toBeUndefined();
    const events = result.events!;
    expect(events).toHaveLength(17);
    expect(events.slice(0, 5).map(({ local_time: local, location, stage, time }) => [local, location, stage, time])).toEqual([
      ['2026-06-16T11:10:00', 'DENVER, NC, US', 'delivered', undefined],
      ['2026-06-16T06:10:00', 'DENVER, NC, US', 'out_for_delivery', undefined],
      ['2026-06-16T04:34:00', 'DENVER, NC, US', 'in_transit', undefined],
      ['2026-06-15T11:47:00', 'CHARLOTTE NC DISTRIBUTION CENTE, US', 'in_transit', undefined],
      ['2026-06-13T16:48:00', 'NORTH HOUSTON TX DISTRIBUTION C, US', 'in_transit', undefined],
    ]);
    // The landing is the line's own row, to the minute but on Beijing's clock.
    expect(events.find(({ description }) => description === 'The flight has arrived.'))
      .toMatchObject({ time: '2026-06-01T09:40:00+08:00', location: 'US', stage: 'in_transit' });
    // The warehouse's receipt is placed at the line's own HY, which names no place.
    const receipt = events.find(({ provider_code: code }) => code === 'ARRIVAL')!;
    expect(receipt).toMatchObject({ time: '2026-05-28T20:10:28+08:00', description: 'Received at Location', stage: 'accepted' });
    expect(receipt.location).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ time: '2026-05-26T15:11:37+08:00', stage: 'registered' });
    expect(result.planned_events ?? []).toEqual([]);
  });

  it('reads a row at a town or facility before the country’s code as a wall clock', () => {
    expect([row('2026-06-16 11:10:00', 'Delivered', 'DENVER, NC, US'), row('2026-06-15 11:47:00', 'On the way', 'CHARLOTTE NC DISTRIBUTION CENTE, US'),
      row('2026-06-01 09:40:00', 'The flight has arrived.', 'US'), row('2026-05-28 20:10:28', 'Received at Location', 'HY', 'ARRIVAL'),
      row('2026-05-31 12:51:24', 'The flight has departed.')].map(hytdClock)).toEqual(['wall', 'wall', 'platform', 'platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHytdTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${HYTD_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHytdPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['HY00', `${NUMBER},${UNKNOWN}`]) {
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
    expect(statusMapAnswer({ carrier: 'hytd', providerCode: 'ARRIVAL', description: 'Received at Location' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'hytd', description: 'Released From Import Customs' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
