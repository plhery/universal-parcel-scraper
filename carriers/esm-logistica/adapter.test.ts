import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [delivered, preparing, undelivered] = numbers.records.map(record => record.number);
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('opens the guest tracking URL and retains minute and day precision', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('esm-logistica', delivered!) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://clientes.esmlogistica.com/seguimiento?guia=' + delivered,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toEqual({
    status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
    last_status_text: 'ENTREGADO', last_update_local: '2026-08-31T10:28',
    events: [
      { description: 'ENTREGADO', local_time: '2026-08-31T10:28', stage: 'delivered', stage_source: 'carrier_map' },
      { description: 'Recibida en base de datos', local_time: '2026-08-21', stage: 'registered', stage_source: 'carrier_map' },
    ],
  });
});

it('keeps the origin preparation and undelivered summaries distinct from registration', () => {
  const progress = parseTracking(fixture('preparing'), preparing!);
  expect(progress).toMatchObject({ status: 'in_transit', last_status_text: 'EN ALISTAMIENTO EN OFICINA DE ORIGEN' });
  expect(progress.events).toEqual([expect.objectContaining({ stage: 'registered', local_time: '2026-08-28' })]);
  expect(progress).not.toHaveProperty('last_update_local');
  const failure = parseTracking(fixture('undelivered'), undelivered!);
  expect(failure).toMatchObject({ status: 'exception', last_status_text: 'NO ENTREGADO' });
  expect(failure.events).toEqual([expect.objectContaining({ stage: 'registered', local_time: '2022-05-27' })]);
  expect(failure).not.toHaveProperty('last_update_local');
});

it('distinguishes a carrier-confirmed absence from a mismatched guide', () => {
  const missing = fixture('missing');
  expect(() => parseTracking(missing, '22000002381174')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(missing, delivered!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('preparing'), delivered!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
