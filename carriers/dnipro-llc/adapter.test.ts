import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DNIPRO_LOOKUP } from './adapter.js';
import { normalizeDniproNumber, parseDnipro } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The first public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = 'CV044917309US';
const OTHER = 'DN123456789';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const CREATED = fixture('created');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A synthetic parcel in the reply's shape, delivered, with a recipient's name and postcodes.
const parcel = (fields: Record<string, unknown> = {}) => ({ items: [{
  number: SAMPLE, transport: 'air', origin: { city: 'ROSELLE', zip: 'NJ, 07203' },
  destination: { city: 'SYNTHETIC TOWN', zip: '00000', name: 'SYNTHETIC RECIPIENT' },
  container: { number: 'SYNT0000000', warehouse: 'NJ', line: 'SYNTHETIC LINE', sea_number: '', booking: '' },
  events: [
    { date: '2026-06-02 14:10:00', code: 8, message: 'Delivered', city: 'Kyiv', zip: '00000' },
    { date: '2026-05-30 08:00:00', code: 999, message: 'Synthetic note', city: '', zip: '' },
    { date: '2026-05-25 18:30:00', code: 2, message: 'Sent from USA', city: 'Roselle, NJ', zip: '07203' },
    { date: '2026-05-22 09:57:32', code: 1, message: `Parcel was created ${SAMPLE}`, city: 'Hialeah, FL', zip: '33010' },
  ],
  ...fields,
}] });

describe('Dnipro LLC numbers', () => {
  it('takes 6 to 40 letters and digits with at least one digit, in capitals and without separators', () => {
    expect(normalizeDniproNumber(` cv 044917309 us `)).toBe(SAMPLE);
    expect(normalizeDniproNumber(OTHER)).toBe(OTHER);
    for (const other of ['', '12345', 'ABCDEFGHIJ', `${SAMPLE};${OTHER}`, `${'A'.repeat(40)}1`, '1'.repeat(65)]) {
      expect(() => normalizeDniproNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Dnipro LLC tracking adapter', () => {
  it('posts the number to the lookup the tracking page posts it to', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(CREATED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(DNIPRO_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(JSON.parse(String(init.body))).toEqual({ number: SAMPLE, language: 'en', fingerprint: '' });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(carrier(fetcher)).toMatchObject({ id: 'dnipro-llc', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s empty list as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"code":"rest_forbidden"}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('{"code":"rate_limited"}', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"code":"rate_limited"}', { status: 400 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"code":"invalid_number"}', { status: 400 }))).toMatchObject({ kind: 'invalid_input' });
    expect(await answer(() => json('{"code":"api_authorization"}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"code":"rest_no_route","message":"No route"}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://dniprollc.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"code":"api_unavailable"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body>Packages Tracking</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"items":null}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('Dnipro LLC replies', () => {
  it('reads the public sample: its creation event on its wall clock, with its town', () => {
    expect(parseDnipro(JSON.parse(CREATED), SAMPLE.toLowerCase())).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: `Parcel was created ${SAMPLE}`, last_update: null, last_update_local: '2026-05-22T09:57:32', expected_delivery: null,
      events: [
        { local_time: '2026-05-22T09:57:32', description: `Parcel was created ${SAMPLE}`, location: 'Hialeah, FL', provider_code: '1',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads events newest first by code, and never the recipient, the postcodes or the container', () => {
    const result = parseDnipro(parcel(), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-06-02T14:10:00' });
    expect((result.events ?? []).map((event) => [event.provider_code, event.stage ?? null])).toEqual([['8', 'delivered'], ['999', null], ['2', 'in_transit'], ['1', 'registered']]);
    expect(result.events?.[0]).toEqual({ local_time: '2026-06-02T14:10:00', description: 'Delivered', location: 'Kyiv', provider_code: '8', stage: 'delivered', stage_source: 'carrier_map' });
    const text = JSON.stringify(result);
    for (const hidden of ['SYNTHETIC RECIPIENT', 'SYNTHETIC TOWN', '00000', '07203', '33010', 'SYNT0000000', 'SYNTHETIC LINE']) expect(text).not.toContain(hidden);
  });

  it('accepts only a parcel under the number asked', () => {
    expect(() => parseDnipro(parcel({ number: 'CV000000000US' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = { items: [...parcel().items, ...parcel().items] };
    expect(() => parseDnipro(twice, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDnipro(parcel({ events: [] }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects changed replies instead of guessing', () => {
    for (const events of [null, [{ date: '22.05.2026', code: 1, message: 'Created' }], [{ date: '2026-05-22 09:57:32', code: 'x', message: 'Created' }],
      [{ date: '2026-05-22 09:57:32', code: 1, message: '' }], ['row']]) {
      expect(() => parseDnipro(parcel({ events }), SAMPLE), JSON.stringify(events)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDnipro({}, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every code the tracking page groups', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'dnipro-llc', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
  });
});
