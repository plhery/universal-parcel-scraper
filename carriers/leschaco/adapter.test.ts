import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import transit from './fixtures/transit.json' with { type: 'json' };
import finished from './fixtures/finished.json' with { type: 'json' };
import absent from './fixtures/not-found.json' with { type: 'json' };
import { parseTracking } from './parser.js';

it('uses the exact bill in the public shipment list and omits estimated movements', async () => {
  const number = 'ALRB261013270093';
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(transit));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('leschaco', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://visible-api.leschaco.com/v1/Tracking/Anonymous/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-11-05T00:00:00' });
  expect(result.events?.map(event => [event.description, event.location])).toEqual([
    ['Departure', 'Antwerpen'], ['Loaded', 'Antwerpen'], ['Gate In CFS', 'Antwerpen'],
  ]);
});

it('preserves empty equipment return as a dated scan with an unresolved stage', () => {
  const result = parseTracking(finished, 'ALRB260908460495');
  expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Gate In Empty', last_update_local: '2026-10-23T11:31:00' });
  expect(result.current_stage).toBeUndefined();
  expect(result.events).toHaveLength(12);
});

it('distinguishes an empty search from a nonmatching result', () => {
  expect(() => parseTracking(absent, 'ALRB241217210064')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(transit, 'ALRB260908460495')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
