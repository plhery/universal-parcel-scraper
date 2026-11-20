import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const bill = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('uses the complete bill and deduplicates actual port movements across cargo items', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('found')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('hoegh-autoliners', bill) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://www.hoeghautoliners.com/api/cargo?search=' + bill, expect.any(Object));
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Discharged' });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ description: 'Loaded', local_time: '2026-11-05', location: 'Kingston (Jam)' });
  expect(result.events?.[3]).toMatchObject({ description: 'Received', local_time: '2026-09-04', location: 'Taicang' });
  expect(result).not.toHaveProperty('expected_delivery');
});

it('rejects mismatched cargo and handles the carrier’s empty reply', () => {
  expect(() => parseTracking(fixture('found'), 'HOEGZZ0000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), 'HOEGZZ0000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
});
