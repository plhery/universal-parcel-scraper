import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import closed from './fixtures/closed.json' with { type: 'json' };
import missing from './fixtures/missing.json' with { type: 'json' };
import pickup from './fixtures/pickup.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [pickupGuide, closedGuide] = numbers.records.map(record => record.number);

it('looks up the exact guide without a customer identity and keeps local movement clocks', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(pickup));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: pickupGuide! });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://calidex.multitrack.trackingpremium.us/tracking/search?type=1&number=${pickupGuide}&user=0&recibo=0&guia=0&consol=0`,
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
  );
  expect(result).toMatchObject({
    current_stage: 'ready_for_pickup', last_status_text: 'Disponible para retiro en Oficina', last_update_local: '2026-11-10T16:58:33',
  });
  expect(result.events).toHaveLength(18);
  expect(result.events?.[0]?.location).toBe('Acarigua (Portuguesa)');
  expect(result.events?.find(event => event.description === 'Proceso Aduanero')?.stage).toBe('customs');
});

it('preserves the native closed state without guessing delivery', () => {
  const result = parseTracking(JSON.stringify(closed), closedGuide!);
  expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Finalizado', last_update_local: '2026-01-20T07:05:23' });
  expect(result.current_stage).toBeUndefined();
  expect(result.events).toHaveLength(11);
});

it('distinguishes a native no-result reply from a mismatched guide or bad data', () => {
  expect(() => parseTracking(JSON.stringify(missing), 'XXX0000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(JSON.stringify(pickup), closedGuide!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('[]', pickupGuide!)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
