import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseGenei } from './parser.js';

const pickupNumber = '93PUOHQK';
const failedNumber = 'IRNCOI8G';
const pickup = JSON.parse(readFileSync(new URL('./fixtures/pickup.json', import.meta.url), 'utf8'));
const failed = JSON.parse(readFileSync(new URL('./fixtures/failed-collection.json', import.meta.url), 'utf8'));
const absent = JSON.parse(readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8'));

describe('Genei guest tracking', () => {
  it('keeps the pickup notice current when GLS deposits the parcel at a ParcelShop', () => {
    const result = parseGenei(pickup, pickupNumber);
    expect(result).toMatchObject({
      current_stage: 'ready_for_pickup', last_status_text: 'DISPONIBLE EN OFICINA',
      last_update: '2026-11-09T10:22:13Z',
    });
    expect(result.events).toHaveLength(11);
    expect(result.events?.some(event => event.stage === 'delivered')).toBe(false);
    expect(result.events).toContainEqual({
      time: '2026-11-09T10:01:00Z', provider_code: '80', description: 'Recogido en Cliente',
      stage: 'accepted', stage_source: 'carrier_map',
    });
    expect(result.delivered_at).toBeUndefined();
  });

  it('preserves a failed collection and orders by the history sequence at equal timestamps', () => {
    const result = parseGenei({ ...failed, data: [...failed.data].reverse() }, failedNumber);
    expect(result).toMatchObject({ current_stage: 'exception', last_status_text: 'RECOGIDA FALLIDA' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[0]).toMatchObject({ provider_code: '9', time: '2026-11-06T11:06:48Z' });
  });

  it('retains a scheduling notice over the previous movement without changing its stage', () => {
    const reminder = pickup.data.find((scan: { id_estado_genei: number }) => scan.id_estado_genei === 13);
    const transit = pickup.data.find((scan: { descripcion_estado: string }) => scan.descripcion_estado === 'EN DELEGACION DESTINO');
    const result = parseGenei({ ...pickup, data: [transit, reminder] }, pickupNumber);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'CONCERTADO PROXIMO REPARTO' });
    expect(result.events?.[0]).toMatchObject({ provider_code: '13' });
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('recognizes only a native empty result as not found and checks every echoed shipment code', () => {
    expect(() => parseGenei(absent, pickupNumber)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGenei({ ...absent, status: 0 }, pickupNumber)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const wrongRow = { ...pickup.data[0], codigo_envio: failedNumber };
    expect(() => parseGenei({ ...pickup, data: [...pickup.data, wrongRow] }, pickupNumber))
      .toThrow(/did not identify the requested shipment/);
  });

  it('looks up a normalized shipment code with the supplied fetch context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(pickup));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, userAgent: 'Test agent', fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: ' 93pu ohqk ' }, { budgetMs: 2_000, signal: new AbortController().signal }))
      .resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://apiv2.genei.es/api/v1/tracking/93PUOHQK');
    expect(new Headers(request?.headers).get('user-agent')).toBe('Test agent');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    await expect(tracker.track({ number: 'unknown' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a verification response as a challenge', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Forbidden', { status: 403 }));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: pickupNumber })).rejects.toMatchObject({ kind: 'challenge' });
  });
});
