import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, RECIBELO_LOOKUP } from './adapter.js';
import { normalizeRecibeloNumber, parseRecibelo } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The two public samples in numbers.json, and an invented number the tracker does not know.
const COMPLETED_SAMPLE = '117490233';
const CREATED_SAMPLE = '117696687';
const OTHER = '900000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const COMPLETED = fixture('completed');
const CREATED = fixture('created');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parcel = (fields: Record<string, unknown> = {}) => ({
  internal_id: OTHER, contact_full_name: 'SYNTHETIC RECIPIENT', current_status: 'En ruta', created_at: '2024-06-05 20:45:12',
  history_statuses: [{ status: 'En ruta', created_at: '2024-06-21 14:28:37' }, { status: 'Creado', created_at: '2024-06-05 20:45:12' }],
  ...fields,
});

describe('Recíbelo numbers', () => {
  it('takes 5 to 40 letters, digits and hyphens with a digit, without spaces, in capitals', () => {
    expect(normalizeRecibeloNumber(` ${COMPLETED_SAMPLE.slice(0, 3)} ${COMPLETED_SAMPLE.slice(3)} `)).toBe(COMPLETED_SAMPLE);
    expect(normalizeRecibeloNumber('ab-12345')).toBe('AB-12345');
    for (const other of ['', '1234', 'ABCDEFGH', `${COMPLETED_SAMPLE}&internal_ids[]=1`, `${COMPLETED_SAMPLE}#2`, '1'.repeat(41), '1'.repeat(65)]) {
      expect(() => normalizeRecibeloNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Recíbelo tracking adapter', () => {
  it('asks the lookup the tracking page asks, with the number as its only parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(COMPLETED));
    await expect(carrier(fetcher).track({ number: COMPLETED_SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${RECIBELO_LOOKUP}?internal_ids[]=${COMPLETED_SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'recibelo', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s not-found answer as not found', async () => {
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
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"message":"Not Found"}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>404 Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.recibelo.cl/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"message":"Server Error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body><div id="___gatsby"></div></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"internal_id":"900000000"}'))).toMatchObject({ kind: 'schema' });
    // A not-found wording with HTTP 200, or an empty list, is not the tracker's answer.
    expect(await answer(() => json(NOT_FOUND))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => json('[]'))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Recíbelo replies', () => {
  it('reads the delivered sample, newest first, on Chile’s wall clock', () => {
    expect(parseRecibelo(JSON.parse(COMPLETED), COMPLETED_SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Completado',
      last_update: null, last_update_local: '2024-06-21T18:36:31', expected_delivery: null,
      events: [
        { local_time: '2024-06-21T18:36:31', description: 'Completado', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2024-06-21T14:28:37', description: 'En ruta', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2024-06-11T16:03:38', description: 'No completado', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { local_time: '2024-06-05T20:45:12', description: 'Creado', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads the created sample', () => {
    expect(parseRecibelo(JSON.parse(CREATED), CREATED_SAMPLE)).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'Creado', last_update_local: '2024-06-08T18:31:19',
      events: [{ local_time: '2024-06-08T18:31:19', description: 'Creado', stage: 'registered', stage_source: 'carrier_map' }],
    });
  });

  it('never reads the recipient’s name', () => {
    for (const reply of [COMPLETED, CREATED]) expect(JSON.stringify(parseRecibelo(JSON.parse(reply), JSON.parse(reply)[0].internal_id))).not.toContain('RECIPIENT');
    expect(JSON.stringify(parseRecibelo([parcel()], OTHER))).not.toContain('SYNTHETIC');
  });

  it('keeps a status the map does not know visible', () => {
    const answer = parseRecibelo([parcel({ current_status: 'Reprogramado', history_statuses: [{ status: 'Reprogramado', created_at: '2024-06-22 09:00' }] })], OTHER);
    expect(answer).toMatchObject({ status: 'unknown', last_status_text: 'Reprogramado' });
    expect(answer.events).toEqual([{ local_time: '2024-06-22T09:00:00', description: 'Reprogramado' }]);
    expect(parseRecibelo([parcel({ history_statuses: [] })], OTHER)).toMatchObject({ current_stage: 'out_for_delivery', summary_only: true, events: [] });
  });

  it('shows the one parcel the tracking page shows when several share the number, and leaves the answer open otherwise', () => {
    const hidden = parcel({ current_status: 'Sin comuna', history_statuses: [{ status: 'Sin comuna', created_at: '2024-06-04 10:00:00' }] });
    expect(parseRecibelo([hidden, parcel()], OTHER)).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(parseRecibelo([hidden], OTHER)).toMatchObject({ current_stage: 'exception', last_status_text: 'Sin comuna' });
    expect(() => parseRecibelo([parcel(), parcel()], OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses an answer for another parcel', () => {
    expect(() => parseRecibelo(JSON.parse(COMPLETED), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, {}, 'x', [null], [parcel({ internal_id: null })], [parcel({ history_statuses: {} })],
      [parcel({ current_status: null })], [parcel({ history_statuses: [{ status: 'Creado' }] })], [parcel({ history_statuses: [{ created_at: '2024-06-05 20:45:12' }] })],
      [parcel({ history_statuses: [{ status: 'Creado', created_at: '05/06/2024 20:45' }] })], [parcel({ history_statuses: [{ status: 'Creado', created_at: '2024-02-30 20:45:12' }] })],
      Array.from({ length: 21 }, () => parcel())]) {
      expect(() => parseRecibelo(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Recíbelo statuses', () => {
  it('maps every status by its whole wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'recibelo', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
