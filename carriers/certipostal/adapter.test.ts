import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const returned = numbers.records[0]!.number;
const delivered = numbers.records[1]!.number;
const wrongAddress = numbers.records[2]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('uses the Certipostal guest endpoint and keeps the local return history', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('exception')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('certipostal', returned) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://certi2.api.fivesoftcolombia.com/fivepostal/api/v1.0/public/tag/v3/' + returned,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ current_stage: 'exception', last_update_local: '2026-08-06T14:50:16' });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ description: 'DEVOLUCION - DIGITALIZADA', location: 'MEDELLIN' });
  expect(result.events?.[1]).not.toHaveProperty('stage');
  expect(result.events?.at(-1)).toMatchObject({ description: 'INGRESADA -VALIDADA', stage: 'registered' });
});

it('preserves the recorded delivery time and removes duplicate and administrative entries', () => {
  const result = parseTracking(fixture('delivered'), delivered, 200);
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'ENTREGA SIN IMAGEN', last_update_local: '2026-10-09T09:09:57',
  });
  expect(result.events?.map(event => event.description)).toEqual([
    'ENTREGA SIN IMAGEN', 'DISTRIBUCION', 'EN BODEGA ORIGEN', 'INGRESADA EN POS',
  ]);
});

it('keeps distinct distribution scans and excludes later certificate activity', () => {
  const result = parseTracking(fixture('wrong-address'), wrongAddress, 200);
  expect(result).toMatchObject({ current_stage: 'exception', last_update_local: '2026-09-02T09:56:09' });
  expect(result.events?.filter(event => event.description === 'DISTRIBUCION')).toHaveLength(2);
  expect(result.events).toHaveLength(6);
});

it('requires the requested guide in the shipment and all of its scans', () => {
  expect(() => parseTracking(fixture('delivered'), returned, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const response = JSON.parse(fixture('exception'));
  response.data_track[0].tagid = Number(delivered);
  expect(() => parseTracking(JSON.stringify(response), returned, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
