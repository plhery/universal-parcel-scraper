import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FLIP_LOOKUP, flipLookupForms } from './adapter.js';
import { normalizeFlipNumber, parseFlip } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json, and an invented number the tracker does not know.
const SAMPLE = 'TL202601-023818';
const OTHER_SAMPLE = '464154997975431';
const UNKNOWN = 'TL209901-000001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Flip Xpress numbers', () => {
  it('takes 6 to 40 letters, digits and hyphens with a digit, in capitals, and never a separator', () => {
    expect(normalizeFlipNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeFlipNumber('TL202601023818')).toBe('TL202601023818');
    expect(normalizeFlipNumber(OTHER_SAMPLE)).toBe(OTHER_SAMPLE);
    for (const other of ['', '12345', 'ABCDEFGH', '-12345678', '12345678-', `${SAMPLE},${OTHER_SAMPLE}`, 'TL202601/023818', `${'A'.repeat(40)}1`, '1'.repeat(65)]) {
      expect(() => normalizeFlipNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Flip Xpress tracking adapter', () => {
  it('asks the lookup the tracking page asks, with the number as its waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${FLIP_LOOKUP}?awb_number=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'flipxpress', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('asks a booking reference that lost its hyphen in both forms, and reads the one the tracker holds', async () => {
    expect(flipLookupForms('TL202601023818')).toEqual(['TL202601023818', SAMPLE]);
    expect(flipLookupForms(SAMPLE)).toEqual([SAMPLE]);
    expect(flipLookupForms(OTHER_SAMPLE)).toEqual([OTHER_SAMPLE]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: 'TL202601023818' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${FLIP_LOOKUP}?awb_number=TL202601023818%2C${SAMPLE}`);
  });

  it('reads the tracker’s empty list as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"detail":"Forbidden"}', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.flipxp.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"message":"error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => json('{"status": 0, "message": "Error", "data": []}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<!doctype html><html><body><div id="root"></div></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"status": 1, "message": "Manifest Status"}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('Flip Xpress replies', () => {
  it('reads the delivered sample, newest first, with UTC instants and without the driver or recipient', () => {
    const result = parseFlip(JSON.parse(DELIVERED), SAMPLE.toLowerCase());
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered - Normal',
      last_update: '2026-02-09T12:40:27.208Z', expected_delivery: null,
      events: [
        { time: '2026-02-09T12:40:27.208Z', description: 'Delivered - Normal', provider_code: '2', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-02-09T04:03:18.855Z', description: 'Out for delivery', provider_code: '6', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-02-09T04:03:18.849Z', description: 'Picked', provider_code: '13', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-09T04:01:31.054Z', description: 'Out for delivery', provider_code: '6', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-02-09T04:01:31.039Z', description: 'Picked', provider_code: '13', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-07T16:41:21.565Z', description: 'Picked', provider_code: '13', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-07T15:09:45.793Z', description: 'Created', provider_code: '12', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const withheld of ['[recipient', '[sender', 'XPS', 'Received by', '[30]']) expect(serialized).not.toContain(withheld);
  });

  it('accepts only an entry for the number asked, and names an exception beside its status', () => {
    const payload = JSON.parse(DELIVERED) as { data: Array<{ awb_number: string; tracking: Array<Record<string, unknown>> }> };
    expect(() => parseFlip(payload, OTHER_SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    payload.data[0]!.tracking.push({ status_code: '99', status_real_name: 'Undelivered', exception: 'Customer not reachable',
      timestamp: '2026-02-10T08:00:00Z' });
    expect(parseFlip(payload, SAMPLE)).toMatchObject({ last_status_text: 'Undelivered - Customer not reachable', last_update: '2026-02-10T08:00:00Z' });
    payload.data[0]!.tracking = [];
    expect(() => parseFlip(payload, SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('rejects a status without its time or wording as a changed reply', () => {
    const row = (fields: Record<string, unknown>) => ({ status: 1, data: [{ awb_number: SAMPLE, tracking: [{ status_code: '2',
      status_real_name: 'Delivered - Normal', timestamp: '2026-02-09T12:40:27.208Z', ...fields }] }] });
    expect(() => parseFlip(row({ timestamp: '09-02-2026 12:40:27' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlip(row({ status_real_name: null }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlip(row({ status_code: 'x' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every listed status', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'flipxpress', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
