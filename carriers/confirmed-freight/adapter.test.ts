import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');
const history = fixture('history');

it('reads grouped and dated shipment movements from the exact reference', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('confirmed-freight', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://www.confirmedfreight.com/track/' + number + '/', expect.any(Object));
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'DELIVERED', last_update_local: '2018-12-25T11:23' });
  expect(result.events).toHaveLength(5);
  expect(result.events?.[1]).toMatchObject({ description: 'CLEARED CUSTOMS', stage: 'customs', local_time: '2018-12-24T09:22' });
  expect(result.events?.[3]).toMatchObject({ description: 'TENDERED @ JFK', location: 'JFK', local_time: '2018-12-23T17:35' });
  expect(result).not.toHaveProperty('last_update');
});

it('checks identity even when the carrier returns a missing shipment page', () => {
  const missing = fixture('missing');
  expect(() => parseTracking(history, 'NO-CF-GUIDE-000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(missing, 'NO-CF-GUIDE-000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(missing, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
