import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('checks the guide and keeps dated scans with the carrier’s local time', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('exception')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('pronto-envios', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.prontoenvios.fivesoft.com.co/fivepostal/api/v1.0/public/tag/v3/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ current_stage: 'exception', last_update_local: '2026-09-24T14:35:43' });
  expect(result.events).toHaveLength(5);
  expect(result.events?.[0]).toMatchObject({ description: 'DEVOLUCION - DIGITALIZADA', location: 'PALMIRA' });
  expect(result.events?.at(-1)).toMatchObject({ description: 'INGRESADA EN POS', stage: 'registered' });
});

it('keeps explicit delivery as the latest shipment event after administrative scans', () => {
  const result = parseTracking(fixture('delivered'), numbers.records[1]!.number, 200);
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'ENTREGA SIN IMAGEN', last_update_local: '2025-05-22T17:38:11',
  });
  expect(result.events).toHaveLength(6);
});

it('requires the shipment and movement guide and checks the carrier’s missing reply', () => {
  expect(() => parseTracking(fixture('another-notice'), number, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const response = JSON.parse(fixture('exception'));
  response.data_track[0].tagid = Number(numbers.records[2]!.number);
  expect(() => parseTracking(JSON.stringify(response), number, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '625876700935', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing'), number, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
