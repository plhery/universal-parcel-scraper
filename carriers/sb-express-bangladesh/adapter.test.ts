import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/hub-received.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('restores the printed number and retains the delivered event before the latest hub scan', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('sb-express-bangladesh', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.sbexpresslimited.com/api/track',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ tracking_number: number }) }),
  );
  expect(result).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Hub received', last_update_local: '2026-10-02T19:37:00',
  });
  expect(result.events?.map(event => [event.description, event.local_time, event.location])).toEqual([
    ['Hub received', '2026-10-02T19:37:00', 'Dhaka South Hub'],
    ['Delivered', '2026-09-30T15:47:00', undefined],
    ['Out for delivery', '2026-09-20T02:17:00', 'Dhanmondi Dispatch Station'],
    ['Hub received', '2026-09-20T00:17:00', 'Dhaka Central Hub'],
    ['Picked up', '2026-09-19T22:17:00', undefined],
  ]);
});

it('rejects a reply for a different parcel', () => {
  expect(() => parseTracking(fixture, 'NET-00000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
