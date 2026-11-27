import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, IBEROMAIL_CLIENT_KEY, IBEROMAIL_LOOKUP } from './adapter.js';
import { normalizeIberomailNumber, parseIberomail } from './parser.js';
import { iberomailStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' replies; the tests derive invented trackings from them.
const DOMESTIC = 'W313153';
const ABROAD = 'W299199';
const SUMMARY = 'W296517';
const PARTNER = 'LE252673997BE';
const OTHER = 'W9900017';

type Checkpoint = { message: string | null; checkpoint_time: string | null; location: string | null } & Record<string, unknown>;
type Tracking = Record<string, unknown> & { order_id: string; tracking_number: string; checkpoints: Checkpoint[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Tracking[];
/** The domestic sample's tracking under another number, with fields replaced. */
const tracking = (changes: Partial<Tracking> = {}): Tracking => ({ ...fixture(DOMESTIC)[0]!, order_id: OTHER, tracking_number: OTHER, ...changes });
const row = (message: string | null, time: string | null, location: string | null = null): Checkpoint => ({ ...fixture(DOMESTIC)[0]!.checkpoints[0]!, message, checkpoint_time: time, location });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scans = (result: ReturnType<typeof parseIberomail>) => result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null]);

describe('Iberomail numbers', () => {
  it('takes letters and digits in capitals', () => {
    expect(normalizeIberomailNumber(` ${DOMESTIC.toLowerCase()} `)).toBe(DOMESTIC);
    expect(normalizeIberomailNumber(PARTNER)).toBe(PARTNER);
    for (const other of ['', 'W12', 'WABCDEF', 'W313153/1', `W${'1'.repeat(40)}`]) {
      expect(() => normalizeIberomailNumber(other), other).toThrow('Enter the Iberomail waybill number');
    }
  });
});

describe('Iberomail tracking adapter', () => {
  it('asks the search behind the tracker page with the page’s key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(DOMESTIC)));
    await expect(carrier(fetcher).track({ number: DOMESTIC.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${IBEROMAIL_LOOKUP}?keyword=${DOMESTIC}&lang=en`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'X-Client-Key': IBEROMAIL_CLIENT_KEY }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'iberomail', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the empty list as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, checks, failures, pages and moved routes apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({ meta: { code: 429 } }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<html>Request blocked</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<title>502 Bad Gateway</title>', { status: 502, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 301, headers: { Location: 'https://iberomail.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('[', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ meta: { code: 401, message: 'Unauthorized' } }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ data: [] }))).toMatchObject({ kind: 'schema' });
    // A reply that lists another number says nothing about this one.
    expect(await answer(() => json(fixture(DOMESTIC)))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Iberomail replies', () => {
  it('reads the domestic sample: its rows on their wall clock, and the delivery under the proof noted after it', () => {
    const result = parseIberomail(fixture(DOMESTIC), DOMESTIC);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'ENTREGADO',
      last_update: null, last_update_local: '2026-10-26T17:17:00', expected_delivery: null,
    });
    expect(scans(result)).toEqual([
      ['2026-10-26T17:17:00', 'ENTREGADO', 'PT.GOLEGA', 'delivered'],
      ['2026-10-26T17:16:00', 'POD Anotado en DST', null, 'pending'],
      ['2026-10-26T16:15:00', 'ENTREGADO con Firma', null, 'delivered'],
      ['2026-10-26T11:20:00', 'EN REPARTO', 'PT.GOLEGA', 'out_for_delivery'],
      ['2026-10-26T10:41:41', 'EN DELEGACION DESTINO', 'PT.GOLEGA', 'in_transit'],
      ['2026-10-24T03:28:48', 'EN PLATAFORMA DE DESTINO', 'PT.PLT.MEALHADA', 'in_transit'],
      ['2026-10-23T18:14:07', 'RECIBIDA INFORMACION', 'PT.MESSINES', 'registered'],
      ['2026-10-23T12:37:31', 'GRABADO', 'OFICINA CENTRAL', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    // The signatory's id and name stay behind; the number is Iberomail's own, so there is no partner.
    expect(JSON.stringify(result)).not.toMatch(/Synthetic|NOMBRE|DNI/);
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads the sample sent abroad: the partner’s S10 number and its rows up to the return', () => {
    const result = parseIberomail(fixture(ABROAD), ABROAD);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'exception', last_status_text: 'Back to sender: transfer cancelled - addressee unreachable',
      last_update_local: '2026-08-18T22:00:00', delivery_tracking_number: PARTNER,
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(scans(result)).toEqual([
      ['2026-08-18T22:00:00', 'Back to sender: transfer cancelled - addressee unreachable', null, 'exception'],
      ['2026-07-31T13:30:00', 'Item presented at the Customs', null, 'customs'],
      ['2026-07-17T17:16:00', 'Departure to country of destination', null, 'in_transit'],
      ['2026-07-10T08:14:00', 'Processed', 'Lisboa', 'in_transit'],
    ]);
  });

  it('reads a record whose rows carry no clock as a summary, never as history', () => {
    const result = parseIberomail(fixture(SUMMARY), SUMMARY);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Em trânsito / In Transit',
      last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
    // Rows without a clock beside dated ones are left out of the history.
    const mixed = tracking({ checkpoints: [row('Em processamento / Being Processed', null), ...fixture(DOMESTIC)[0]!.checkpoints] });
    expect(parseIberomail([mixed], OTHER).events).toHaveLength(8);
  });

  it('takes a tracking found by its partner number, and one listed twice', () => {
    const [abroad] = fixture(ABROAD);
    expect(parseIberomail([abroad], PARTNER)).toMatchObject({ current_stage: 'exception', last_update_local: '2026-08-18T22:00:00' });
    expect(parseIberomail([abroad], PARTNER)).not.toHaveProperty('delivery_tracking_number');
    expect(parseIberomail([abroad, { ...abroad!, id: 'another' }], ABROAD).events).toHaveLength(4);
  });

  it('names no shipment when two trackings for the number differ', () => {
    const [abroad] = fixture(ABROAD);
    const later = { ...abroad!, checkpoints: [...abroad!.checkpoints, row('Delivered', '2026-09-01T10:00:00')] };
    expect(() => parseIberomail([abroad, later], ABROAD)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A tracking matched by another field the service searches says nothing about this number.
    expect(() => parseIberomail([tracking({ order_id: 'W1111117', tracking_number: '', title: OTHER })], OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a record without rows as a listed shipment with its partner number', () => {
    expect(() => parseIberomail([tracking({ tracking_number: PARTNER, checkpoints: [] })], OTHER)).toThrow(expect.objectContaining({
      kind: 'indeterminate', reason: 'listed', deliveryTrackingNumber: PARTNER,
    }));
  });

  it('names an estimate field the reply fills, and refuses rows it cannot read', () => {
    expect(parseIberomail([tracking({ expected_delivery: '2026-10-27' })], OTHER)).toMatchObject({ unread_estimates: ['expected_delivery'] });
    expect(parseIberomail([tracking()], OTHER)).not.toHaveProperty('unread_estimates');
    for (const time of ['26/10/2026 17:17', '2026-02-30T10:00:00', '2026-10-26T25:00:00']) {
      expect(() => parseIberomail([tracking({ checkpoints: [row('EN REPARTO', time)] })], OTHER), time)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseIberomail([tracking({ checkpoints: [row(['EN REPARTO'] as unknown as string, '2026-10-26T11:20:00')] })], OTHER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseIberomail([tracking({ checkpoints: 'none' as unknown as Checkpoint[] })], OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Iberomail statuses', () => {
  it('maps every recorded wording whole, and leaves unknown wording to the shared rules', () => {
    for (const entry of statuses.entries) {
      expect(iberomailStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'iberomail', providerCode: null, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage(null, 'some new wording')).toBeUndefined();
    expect(iberomailStage('Out for delivery')?.source).toMatch(/^wording:/);
  });
});
