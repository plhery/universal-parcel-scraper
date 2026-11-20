import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;

it('reads the exact shipment and its dated terminal movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture('history')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(numbers.records[0]!.source.url, expect.any(Object));
  expect(result).toMatchObject({ status: 'delivered', last_update_local: '2021-10-18T13:21' });
  expect(result.events).toHaveLength(10);
  expect(result.events?.[0]).toMatchObject({ location: 'THUNDER BAY, ON', stage: 'delivered' });
  expect(result.events?.[2]).not.toHaveProperty('stage');
  expect(result.events?.[3]).not.toHaveProperty('location');
});

it('rejects the alternate reference a lookup can return', () => {
  expect(() => parseTracking(fixture('different-reference'), '0000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('history').replace('01:21 PM', '99:99 PM'), number))
    .toThrow(expect.objectContaining({ kind: 'schema' }));
});
