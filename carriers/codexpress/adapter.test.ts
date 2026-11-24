import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CODEXPRESS_LOOKUP } from './adapter.js';
import { normalizeCodexpressNumber, parseCodexpress } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The first public sample in numbers.json, and a synthetic barcode far beyond the range in use.
const SAMPLE = 'CODE012951468';
const OTHER = 'CODE999999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (history: unknown[], tracking = '') => ({ success: true, data: { history, tracking } });

describe('CODExpress barcodes', () => {
  it('takes letters and digits with at least one digit, in capitals', () => {
    expect(normalizeCodexpressNumber(` ${SAMPLE.toLowerCase().slice(0, 4)} ${SAMPLE.slice(4)} `)).toBe(SAMPLE);
    expect(normalizeCodexpressNumber('CODE20260001')).toBe('CODE20260001');
    for (const other of ['', 'CODE', 'ABCDEFGHIJ', 'C1', 'CODE-0129/51468', 'C'.repeat(40) + '1', 'C'.repeat(65)]) {
      expect(() => normalizeCodexpressNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('CODExpress tracking adapter', () => {
  it('posts the barcode as JSON to the tracking page’s lookup, as its script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(CODEXPRESS_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(JSON.parse(String(init.body))).toEqual({ tracking_id: SAMPLE });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(carrier(fetcher)).toMatchObject({ id: 'codexpress', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s answer for a barcode the account does not hold as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND, { status: 404 }))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('{"success":false,"error":"Tracking ID is required"}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"success":false,"error":"Something else"}', { status: 404 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.locate2u.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"success":false,"error":"Something went wrong. Please try again."}', { status: 500 })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json(NOT_FOUND))).toMatchObject({ kind: 'schema' });
  });
});

describe('CODExpress replies', () => {
  it('reads the public sample: its statuses newest first, on the wall clock the page shows', () => {
    expect(parseCodexpress(JSON.parse(DELIVERED), SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'Delivered',
      last_status_text: 'Successfully delivered', last_update: null, last_update_local: '2026-05-13T15:18:36',
      events: [
        { local_time: '2026-05-13T15:18:36', description: 'Successfully delivered', provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-05-13T07:05:20', description: 'Package picked up by courier', provider_code: 'Onboard', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-05-13T00:02:05', description: 'Order received and dispatched from depot', provider_code: 'Created', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a parcel on board, keeps a status the map does not know visible, and never reads the live-tracking link', () => {
    const onBoard = parseCodexpress(reply([{ status: 'Created', dateTime: '2026-05-13T00:02:05.264Z' },
      { status: 'Onboard', dateTime: '2026-05-13T07:05:20.207Z' }], 'https://example.invalid/live/synthetic-token'), SAMPLE);
    expect(onBoard).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', provider_code: 'Onboard' });
    expect(JSON.stringify(onBoard)).not.toMatch(/synthetic-token/);
    const unknown = parseCodexpress(reply([{ status: 'Created', dateTime: '2026-05-13T00:02:05Z' }, { status: 'Parked', dateTime: '2026-05-13T08:00:00' }]), SAMPLE);
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-13T08:00:00', description: 'Parked', provider_code: 'Parked' });
    expect(unknown).toMatchObject({ provider_code: 'Parked', last_status_text: 'Parked', current_stage: 'registered' });
  });

  it('keeps two statuses of one second in the tracker’s order', () => {
    const events = parseCodexpress(reply([{ status: 'Onboard', dateTime: '2026-05-13T07:05:20Z' }, { status: 'Delivered', dateTime: '2026-05-13T07:05:20Z' }]), SAMPLE).events!;
    expect(events.map((event) => event.provider_code)).toEqual(['Delivered', 'Onboard']);
  });

  it('answers a parcel listed without a status as having no history', () => {
    expect(() => parseCodexpress(reply([]), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    const row = (dateTime: unknown, status: unknown = 'Created') => reply([{ status, dateTime }]);
    for (const changed of [null, [], {}, { success: true }, { success: false, data: { history: [] } }, { success: true, data: { history: {} } },
      { success: true, data: [] }, row('2026-05-13 00:02:05'), row('2026-02-30T00:02:05Z'), row('2026-05-13T24:02:05Z'),
      row('2026-05-13T00:02:05+10:00'), row(1_778_630_525_000), row(undefined), row('2026-05-13T00:02:05Z', ''), row('2026-05-13T00:02:05Z', 7),
      reply(Array.from({ length: 201 }, () => ({ status: 'Created', dateTime: '2026-05-13T00:02:05Z' })))]) {
      expect(() => parseCodexpress(changed, SAMPLE), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('CODExpress statuses', () => {
  it('maps each status the tracker was seen to give, by its code or the tracker’s wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'codexpress', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('Unknown', 'anything')).toBeUndefined();
  });
});
