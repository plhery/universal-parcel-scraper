import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('restores the GEL reference and preserves the delivery and confirmation scans', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('global-express-logistics-tanzania', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://globalexpress.co.tz/api/track/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered', last_update: '2026-08-07T08:53:34Z',
  });
  expect(result.events?.map(event => [event.description, event.time, event.stage])).toEqual([
    ['Confirmed', '2026-08-07T08:55:36Z', undefined],
    ['Delivered', '2026-08-07T08:53:34Z', 'delivered'],
    ['In Transit', '2026-08-07T08:51:52Z', 'in_transit'],
    ['Picked Up', '2026-08-07T08:36:42Z', 'accepted'],
    ['Courier Assigned', '2026-08-07T08:33:15Z', 'registered'],
    ['Order Created', '2026-08-07T08:28:04Z', 'pending'],
  ]);
});

it('requires the returned parcel to match the supplied tracking number', () => {
  expect(() => parseTracking(fixture, 'GEL-2026-000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
