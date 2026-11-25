import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FOUR_A_LOOKUP } from './adapter.js';
import { normalizeFourANumber, parseFourA } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = '010790148121';
const OTHER = '010700000999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const EMPTY = fixture('empty');
const grid = (body: string) => JSON.parse(body) as { d: { TrackingGrid: string } };
const withGrid = (html: string) => JSON.stringify({ d: { ...grid(DELIVERED).d, TrackingGrid: html } });
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('4A Express numbers', () => {
  it('takes letters and digits with at least one digit, in capitals', () => {
    expect(normalizeFourANumber(` ${SAMPLE} `)).toBe(SAMPLE);
    expect(normalizeFourANumber('ab1234567')).toBe('AB1234567');
    for (const other of ['', '12345', 'ABCDEFGHIJ', `${SAMPLE},${OTHER}`, '0107/90148121', '1'.repeat(21)]) {
      expect(() => normalizeFourANumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('4A Express tracking adapter', () => {
  it('posts the number as the tracking page’s script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(FOUR_A_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify({ AWBNo: SAMPLE }) });
    expect(carrier(fetcher)).toMatchObject({ id: '4a-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps the empty answer for an unknown number open, never not found', async () => {
    const error = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(EMPTY))).track({ number: OTHER }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => page(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page('Forbidden', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => page('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => page('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => page('', { status: 302, headers: { Location: 'https://4aexpress.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => page('Internal error', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => page('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('{"d":'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('{"Message":"Authentication failed."}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('4A Express replies', () => {
  it('reads the public sample: delivered, newest event first, on the stations’ wall clocks', () => {
    const result = parseFourA(JSON.parse(DELIVERED), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'SHIPMENT DELIVERED',
      last_update: null, last_update_local: '2024-01-05T12:25:59', expected_delivery: null,
      events: [
        { local_time: '2024-01-05T12:25:59', description: 'SHIPMENT DELIVERED', location: 'LARNACA', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2024-01-05T08:14:19', description: 'OUT FOR DELIVERY', location: 'LARNACA', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2024-01-05T08:14:07', description: 'PIECES RECEIVED AT LCA 4AEXPRESS.', location: 'LARNACA', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2024-01-04T16:57:41', description: 'IN TRANSIT TO LCA 4AEXPRESS', location: 'ATHENS', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2024-01-04T12:57:48', description: 'SHIPMENT PICKED UP', location: 'ATHENS', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2023-12-18T14:14:26', description: 'SHIPMENT BOOKED', location: 'ATHENS', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The name of whoever received the shipment is never read.
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|Received By/i);
  });

  it('reads a grid for another number as an open answer', () => {
    expect(() => parseFourA(JSON.parse(DELIVERED), '010790148122')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a grid with an invalid date, an event without its activity, no history or no number', () => {
    const html = grid(DELIVERED).d.TrackingGrid;
    const changed = (from: string | RegExp, to: string) => JSON.parse(withGrid(html.replace(from, to))) as unknown;
    expect(() => parseFourA(changed('05-JAN-2024 12:25:59', '32-JAN-2024 12:25:59'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFourA(changed('>SHIPMENT DELIVERED<', '><'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFourA(changed(/<tbody ><tr >[\s\S]*SHIPMENT BOOKED[\s\S]*?<\/tr>/, '<tbody >'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFourA(changed('Awb No.', 'Waybill'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFourA({ d: null }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('4A Express statuses', () => {
  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: '4a-express', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
      expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
    }
  });
});
