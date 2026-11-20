import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [ocean, dated, summary] = numbers.records.map(record => record.number);
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('looks up the exact shipment and preserves the precision of each distinct movement', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('ocean-delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('exfreight', ocean!) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://exfreight.flipstone.com/track/' + ocean,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2025-07-23',
  });
  expect(result.events?.map(event => [event.local_time ?? event.time, event.description])).toEqual([
    ['2025-07-23', 'Delivery complete'],
    ['2025-07-20', 'Arrived at destination port on vessel'],
    ['2025-07-16', 'Customs cleared'],
    ['2025-07-15T17:00:00-07:00', 'Departed transshipment port'],
    ['2025-06-15T09:00:00+09:00', 'Departed transshipment port'],
    ['2025-06-03', 'Loaded on vessel'],
    ['2025-06-03', 'Departed origin port on vessel'],
    ['2025-05-28', 'Booking confirmed'],
  ]);
});

it('reads dated delivery and retains a summary for a confirmed shipment with no dated events', () => {
  expect(parseTracking(fixture('dated-delivered'), dated!)).toMatchObject({
    current_stage: 'delivered', last_update_local: '2022-05-02',
  });
  const result = parseTracking(fixture('summary-delivered'), summary!);
  expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', summary_only: true });
  expect(result.last_update).toBeUndefined();
  expect(result.last_update_local).toBeUndefined();
});

it('recognizes the empty page and rejects a result for another shipment', () => {
  expect(() => parseTracking(fixture('empty-lookup'), ocean!)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('dated-delivered'), ocean!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
