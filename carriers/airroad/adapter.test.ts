import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AIRROAD_LOOKUP } from './adapter.js';
import { normalizeAirroadNumber, parseAirroad } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The first public sample in numbers.json, and an invented number the lookup does not know.
const SAMPLE = 'GFL0125070';
const OTHER = 'GFL9999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (fields: Record<string, unknown> = {}) => ({
  connoteCode: SAMPLE, statusDate: '2026-04-20T06:40:39', statusText: 'On-board for delivery', delivered: false, scans: null,
  estimatedDeliveryDate: null, ...fields,
});

describe('AirRoad consignment numbers', () => {
  it('takes letters and digits with at least one digit, in capitals', () => {
    expect(normalizeAirroadNumber(` ${SAMPLE.toLowerCase().slice(0, 3)} ${SAMPLE.slice(3)} `)).toBe(SAMPLE);
    expect(normalizeAirroadNumber('123456789')).toBe('123456789');
    for (const other of ['', 'GFL01', 'ABCDEFGHIJ', `${SAMPLE};GFL0118266`, 'GFL/0125070', 'G'.repeat(30) + '1', 'G'.repeat(65)]) {
      expect(() => normalizeAirroadNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('AirRoad tracking adapter', () => {
  it('reads the number from the lookup the Quick Track page reads, as its script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${AIRROAD_LOOKUP}${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(carrier(fetcher)).toMatchObject({ id: 'airroad', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the lookup’s answer naming the number asked as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND, { status: 404 }))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing consignment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"message":"Authorization has been denied for this request."}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    // The not-found answer for another number, or a refusal of the request, leaves the answer open.
    expect(await answer(() => json('{"message":"GFL0000001 not found."}', { status: 404 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"message":"The request is invalid."}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json(`{"message":"No HTTP resource was found that matches the request URI '${AIRROAD_LOOKUP}${OTHER}'."}`, { status: 404 })))
      .toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>404 - File or directory not found.</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.airroad.com.au/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"message":"An error has occurred."}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json(NOT_FOUND))).toMatchObject({ kind: 'schema' });
  });
});

describe('AirRoad replies', () => {
  it('reads the public sample: delivered, on the wall clock the page shows', () => {
    expect(parseAirroad(JSON.parse(DELIVERED), SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-04-21T12:20:00', expected_delivery: null, summary_only: true,
      events: [{ local_time: '2026-04-21T12:20:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' }],
    });
  });

  it('never reads the name a delivered consignment’s status text gives', () => {
    const delivered = parseAirroad([row({ statusText: 'A. SYNTHETIC RECEIVER', delivered: true, statusDate: '2026-04-21T12:20:00' })], SAMPLE);
    expect(delivered).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(JSON.stringify(delivered)).not.toMatch(/SYNTHETIC|RECEIVER/);
  });

  it('reads a consignment on its way, with its depot and the estimate the page shows', () => {
    expect(parseAirroad([row({ estimatedDeliveryDate: '2026-04-21T00:00:00' })], SAMPLE)).toEqual({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'On-board for delivery', last_update: null, last_update_local: '2026-04-20T06:40:39',
      expected_delivery: '2026-04-21', summary_only: true,
      events: [{ local_time: '2026-04-20T06:40:39', description: 'On-board for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' }],
    });
    const depot = parseAirroad([row({ statusText: 'Scanned in SYDNEY Depot', statusDate: '2026-04-19T21:05:12.37' })], SAMPLE);
    expect(depot.events).toEqual([{ local_time: '2026-04-19T21:05:12', description: 'Scanned in SYDNEY Depot', location: 'SYDNEY',
      stage: 'in_transit', stage_source: 'carrier_map' }]);
    // An estimate behind the status is left out.
    expect(parseAirroad([row({ estimatedDeliveryDate: '2026-04-19T00:00:00' })], SAMPLE).expected_delivery).toBeNull();
  });

  it('keeps a status text the map does not know visible', () => {
    const unknown = parseAirroad([row({ statusText: 'Parked' })], SAMPLE);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Parked', summary_only: true });
    expect(unknown.events).toEqual([{ local_time: '2026-04-20T06:40:39', description: 'Parked' }]);
  });

  it('answers a consignment listed without a status as having no history', () => {
    expect(() => parseAirroad([row({ statusText: null, statusDate: '0001-01-01T00:00:00' })], SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses an answer for another consignment', () => {
    // The lookup also matches other references, and then names another consignment.
    expect(() => parseAirroad([row({ connoteCode: 'GFL0000001' })], SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAirroad([row(), row()], SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, {}, [], [null], 'x', { message: 'x' }, [row({ connoteCode: 7 })], [row({ delivered: 'true' })],
      [row({ statusDate: '2026-04-20 06:40:39' })], [row({ statusDate: '2026-02-30T06:40:39' })], [row({ statusDate: '2026-04-20T24:40:39' })],
      [row({ statusDate: '2026-04-20T06:40:39+10:00' })], [row({ statusDate: '2026-04-20T06:40:39Z' })], [row({ statusDate: null })],
      [row({ statusDate: '0001-01-01T00:00:00' })], [row({ statusText: 7 })], [row({ scans: {} })], [row({ estimatedDeliveryDate: 'soon' })],
      Array.from({ length: 11 }, () => row())]) {
      expect(() => parseAirroad(changed, SAMPLE), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('AirRoad statuses', () => {
  it('maps each status text Quick Track was seen to give, and any depot’s scan', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'airroad', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'scanned in melbourne depot')).toBe('in_transit');
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
