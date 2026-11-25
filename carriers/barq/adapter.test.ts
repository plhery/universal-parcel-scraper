import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BARQ_LOOKUP } from './adapter.js';
import { BARQ_QUERY, normalizeBarqNumber, parseBarq } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = 'XP697997460';
const OTHER = 'ZZ000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const COMPLETED = fixture('completed');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A synthetic order in the service's shape.
const order = (fields: Record<string, unknown> = {}, logs: unknown = []) => ({
  data: { orderTracking: { trackingNo: OTHER, orderStatus: 'intransit', orderStatusReason: null, ...fields }, publicFetchOrder: { orderLogs: logs } },
});

describe('BARQ numbers', () => {
  it('takes two letters and nine digits, in capitals, as the service reads them', () => {
    expect(normalizeBarqNumber(` ${SAMPLE.toLowerCase().slice(0, 2)} ${SAMPLE.slice(2)} `)).toBe(SAMPLE);
    for (const other of ['', 'XP69799746', 'XP6979974601', '12697997460', 'XPX697997460', `${SAMPLE};${OTHER}`, 'XP/697997460', '1'.repeat(65)]) {
      expect(() => normalizeBarqNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('BARQ tracking adapter', () => {
  it('posts the tracking page’s query for the number to the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(COMPLETED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(BARQ_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(JSON.parse(String(init.body))).toEqual({ query: BARQ_QUERY, variables: { trackingNo: SAMPLE } });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    // The query never asks for the merchant or the coordinates.
    expect(BARQ_QUERY).not.toMatch(/merchant|origin|destination|currentLocation/);
    expect(carrier(fetcher)).toMatchObject({ id: 'barq', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the service’s not-found answer as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"detail":"Forbidden"}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    // Only both halves of the query answering the order unknown is the service's not-found answer.
    const errors = (...messages: string[]) => JSON.stringify({ data: null, errors: messages.map((message) => ({ message })) });
    expect(await answer(() => json(errors('Order not found')))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json(errors('Invalid Tracking Number')))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json(errors('Internal server error')))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json(errors('Too many requests')))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json(JSON.stringify({ ...order(), errors: [{ message: 'Order not found' }] })))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json(errors('Bad request'), { status: 400 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>404 Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://barqfleet.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"message":"error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body><div id="root"></div></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"data":{}}'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"data":null}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('BARQ replies', () => {
  it('reads the public sample: its logs, newest first, with the offset BARQ states', () => {
    expect(parseBarq(JSON.parse(COMPLETED), SAMPLE.toLowerCase())).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Completed',
      last_update: '2021-11-22T16:45:25+03:00', expected_delivery: null,
      events: [
        { time: '2021-11-22T16:45:25+03:00', description: 'Completed', provider_code: 'completed', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2021-11-22T15:22:25+03:00', description: 'Intransit', provider_code: 'intransit', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2021-11-22T13:09:37+03:00', description: 'Picked up', provider_code: 'picked_up', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2021-11-22T12:57:38+03:00', description: 'Ready for delivery', provider_code: 'ready_for_delivery', stage: 'registered',
          stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads an order without logs by its status alone, with the reason the service gives', () => {
    expect(parseBarq(order({ orderStatus: 'delivery_attempt_failed', orderStatusReason: 'Customer not available' }), OTHER)).toEqual({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'delivery attempt failed: Customer not available', last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
  });

  it('keeps an unknown status visible without a stage', () => {
    const result = parseBarq(order({ orderStatus: 'some_new_status' }, [{ status: 'some_new_status', statusHumanReadable: 'Some new status',
      createdAt: '2026-01-02 03:04:05 +0300' }]), OTHER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Some new status', last_update: '2026-01-02T03:04:05+03:00' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('refuses another order’s reply and a changed reply', () => {
    expect(() => parseBarq(order({ trackingNo: SAMPLE }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBarq(order({}, [{ status: 'completed', createdAt: '2021-11-22 16:45:25' }]), OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBarq(order({}, [{ status: 'Completed!', createdAt: '2021-11-22 16:45:25 +0300' }]), OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBarq(order({ orderStatus: null }), OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBarq(order({}, 'logs'), OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBarq({ data: { orderTracking: null, publicFetchOrder: null } }, OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('BARQ status map', () => {
  it('answers each status code its statuses.json records', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'barq', providerCode: code, description: wording }), code).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'barq', providerCode: null, description: 'Completed' })).toEqual({ kind: 'unknown' });
  });
});
