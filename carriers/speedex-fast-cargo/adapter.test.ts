import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('looks up the exact docket and keeps the day-level scan order', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('speedex-fast-cargo', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://speedexfastcargo.com/track.php?awb=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered Successfully', last_update_local: '2026-09-05',
  });
  expect(result.events?.map(event => [event.local_time, event.description, event.location])).toEqual([
    ['2026-09-05', 'Delivered', undefined],
    ['2026-09-05', 'Out For Delivery', undefined],
    ['2026-09-05', 'Inscan', 'Ahmedabad'],
    ['2026-09-04', 'Outscan', 'Mumbai'],
  ]);
});

it('recognizes the native empty response and rejects a shipment for a different docket', () => {
  expect(() => parseTracking(fixture('empty-lookup'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  const returned = fixture('delivered').replace(number, '000000');
  expect(() => parseTracking(returned, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
