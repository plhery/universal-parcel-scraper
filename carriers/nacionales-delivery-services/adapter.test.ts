import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('restores the native NX reference and returns four ordered UTC movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('nacionales-delivery-services', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.nexgo.delivery/api/public/shipments/track/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Entregado', last_update: '2026-07-14T19:51:46.163Z',
  });
  expect(result.events?.map(event => [event.time, event.stage])).toEqual([
    ['2026-07-14T19:51:46.163Z', 'delivered'],
    ['2026-07-10T17:41:45.128Z', 'in_transit'],
    ['2026-07-08T06:26:48.256Z', 'accepted'],
    ['2026-07-08T00:28:08.134Z', 'pending'],
  ]);
});

it('requires the same tracking number before reading shipment fields', () => {
  expect(() => parseTracking(fixture, 'NX-2026-0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('reports an HTTP 404 as a missing shipment', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number })).rejects.toMatchObject({ kind: 'not_found' });
});
