import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AQX_LOOKUP } from './adapter.js';
import { normalizeAqxNumber, parseAqx } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The two public samples in numbers.json, and an invented reference the tracker does not know.
const DELIVERED_SAMPLE = 'HF-BC5DCC0A';
const LABEL_SAMPLE = 'HF-BD4A920D';
const OTHER = 'HF-00000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const LABEL = fixture('label');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const text = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/plain', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A synthetic shipment in the reply's shape, with a delivery after the flight.
const reply = (fields: Record<string, unknown> = {}) => ({
  success: true, shipment: {
    aqxTrackingId: OTHER, carrier: 'AQX Express', status: 'Delivered', serviceTier: 'AQX Express Priority (2-4 Days)',
    origin: 'Inglewood, CA (USA)', destination: 'SYNTHETIC TOWN, Kuwait', destinationCity: 'SYNTHETIC TOWN', destinationCountry: 'Kuwait',
    recipientMasked: 'Synthetic N.', totalWeightKg: 2.5, totalPieces: 1, createdAt: '2026-01-02T03:04:05.000Z',
    events: [
      { id: 'a', status: 'Shipment Request Received', location: 'Inglewood, CA', description: 'Shipment order registered.', timestamp: '2026-01-02T03:04:05.000Z' },
      { id: 'b', status: 'Delivered', location: 'Kuwait City', description: 'Delivered to SYNTHETIC NAME', timestamp: '2026-01-06T10:00:00.000Z' },
    ],
    ...fields,
  },
});

describe('AQX Logistics numbers', () => {
  it('takes HF- and eight hexadecimal characters, with or without the hyphen, in capitals', () => {
    expect(normalizeAqxNumber(` ${DELIVERED_SAMPLE.toLowerCase()} `)).toBe(DELIVERED_SAMPLE);
    expect(normalizeAqxNumber(LABEL_SAMPLE.replace('-', ''))).toBe(LABEL_SAMPLE);
    for (const other of ['', 'HF-BC5DCC0', 'HF-BC5DCC0AB', 'HF-BC5DCC0G', 'HF_BC5DCC0A', 'AQX-8492-9102-KSA', '1234567890', 'HF-'.repeat(30)]) {
      expect(() => normalizeAqxNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('AQX Logistics tracking adapter', () => {
  it('reads the number from the lookup the tracking page reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: 'hfbc5dcc0a' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${AQX_LOOKUP}?id=${DELIVERED_SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'aqx-logistics', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s not-found answer as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND, { status: 404 }))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => text('Forbidden', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json(NOT_FOUND))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json(NOT_FOUND, { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"error":"Tracking ID is required"}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"error":"Something else"}', { status: 404 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<h1>404</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://aqxlogistics.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"error":"x"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body><div id="__next"></div></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"success":true}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('AQX Logistics replies', () => {
  it('reads the delivered sample: its status leads its registration event, without a time', () => {
    expect(parseAqx(JSON.parse(DELIVERED), DELIVERED_SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, expected_delivery: null, service_name: 'AQX Express Priority (2-4 Days)', destination_country: 'SA', weight_kg: 7.7,
      events: [
        { time: '2026-08-31T14:40:11.394Z', description: 'Shipment Request Received', location: 'Inglewood, CA', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads the paid sample, newest event first, each an instant in UTC', () => {
    expect(parseAqx(JSON.parse(LABEL), LABEL_SAMPLE)).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', last_status_text: 'Shipment Request Received',
      last_update: '2026-11-12T20:55:48.285Z', expected_delivery: null, service_name: 'AQX Express Priority (2-4 Days)', destination_country: 'AU',
      weight_kg: 10.5,
      events: [
        { time: '2026-11-12T20:55:48.285Z', description: 'Shipment Request Received', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-11-12T20:55:43.062Z', description: 'AQX Air Waybill Generated', location: 'Inglewood, CA', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('lets the newest event lead when it agrees with the status', () => {
    expect(parseAqx(reply(), OTHER)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: '2026-01-06T10:00:00Z', destination_country: 'KW',
    });
  });

  it('never reads the recipient, the destination town or the event descriptions', () => {
    const answer = JSON.stringify(parseAqx(reply(), OTHER));
    for (const hidden of ['SYNTHETIC', 'Synthetic', 'registered.']) expect(answer).not.toContain(hidden);
    expect(JSON.stringify(parseAqx(JSON.parse(DELIVERED), DELIVERED_SAMPLE))).not.toMatch(/Recipient|Town/);
  });

  it('keeps an unknown status visible and stands on the status alone without events', () => {
    const unknown = parseAqx(reply({ status: 'Parked', events: [{ status: 'Parked', location: '', timestamp: '2026-01-03T00:00:00Z' }] }), OTHER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Parked' });
    expect(unknown.current_stage).toBeUndefined();
    expect(parseAqx(reply({ status: 'PAID', events: [] }), OTHER)).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'PAID', last_update: null, summary_only: true, events: [],
    });
    expect(() => parseAqx(reply({ status: 'Parked', events: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    // A country the catalog cannot name keeps its label.
    expect(parseAqx(reply({ destinationCountry: 'Atlantis' }), OTHER)).toMatchObject({ destination_country_name: 'Atlantis' });
  });

  it('refuses an answer for another shipment', () => {
    expect(() => parseAqx(JSON.parse(DELIVERED), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, [], 'x', {}, { success: true }, { success: false, shipment: {} }, reply({ aqxTrackingId: 7 }), reply({ status: null }),
      reply({ events: {} }), reply({ serviceTier: 7 }), reply({ totalWeightKg: '2' }), reply({ events: [null] }),
      reply({ events: [{ location: 'x', timestamp: '2026-01-03T00:00:00Z' }] }), reply({ events: [{ status: 'Delivered', timestamp: '2026-01-03 00:00' }] }),
      reply({ events: [{ status: 'Delivered' }] }), reply({ events: [{ status: 'Delivered', location: 7, timestamp: '2026-01-03T00:00:00Z' }] }),
      reply({ events: Array.from({ length: 201 }, () => ({ status: 'Delivered', timestamp: '2026-01-03T00:00:00Z' })) })]) {
      expect(() => parseAqx(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('AQX Logistics statuses', () => {
  it('maps every status it was seen to give, by its whole wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'aqx-logistics', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
