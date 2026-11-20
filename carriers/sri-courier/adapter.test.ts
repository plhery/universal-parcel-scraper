import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('restores the printed reference and reads only its current stage', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('out-for-delivery')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('sri-courier', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://sricourier.lk/track?tracking_no=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery', summary_only: true,
  });
  expect(result.events).toBeUndefined();
  expect(result.last_update).toBeUndefined();
});

it('distinguishes the empty form from a result for a different shipment', () => {
  expect(() => parseTracking(fixture('empty-lookup'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  const mismatched = fixture('out-for-delivery').replace(number, 'SC-000000');
  expect(() => parseTracking(mismatched, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
