import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('returns the warehouse, air, customs and delivery movements for the exact STOO reference', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('stoo', number) });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://stline.stload.com/api/external/tracking/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: '배송 완료', last_update_local: '2026-01-22T12:09:00',
  });
  expect(result.events?.map(event => [event.provider_code, event.local_time, event.stage])).toEqual([
    ['700', '2026-01-22T12:09:00', 'delivered'],
    ['400', '2026-01-19T07:23:00', 'in_transit'],
    ['200', '2026-01-18T11:20:00', 'in_transit'],
    ['100', '2026-01-18T08:45:00', 'in_transit'],
    ['30', '2026-01-17T15:30:00', 'in_transit'],
    ['20', '2026-01-17T12:51:01', undefined],
    ['11', '2026-01-16T14:16:08', 'accepted'],
    ['10', '2026-01-16T09:08:32', 'registered'],
  ]);
  expect(result.last_update).toBeUndefined();
});

it('filters incomplete steps and requires the carrier to echo the exact number', () => {
  const pending = structuredClone(fixture);
  pending.data.trackingHistory.at(-1)!.isPassed = false;
  const result = parseTracking(pending, number);
  expect(result.events).toHaveLength(7);
  expect(result.last_update_local).toBeUndefined();
  expect(() => parseTracking(fixture, 'WRONG-REFERENCE')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
