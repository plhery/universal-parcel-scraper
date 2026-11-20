import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const movements = fixture('movements');
const number = numbers.records[0]!.number;

it('searches the Ellerman widget for the exact container and reads its movement log', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(movements));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://api.orcapayments.app/container_tracking?q=${number}&company_id=5`, expect.any(Object));
  expect(result).toMatchObject({
    status: 'in_transit', last_update_local: '2024-08-27T13:09:00', last_status_text: 'Empty container returned',
  });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ stage: 'in_transit', provider_code: 'OUTG', location: 'NEWARK(PNCT) F577' });
  expect(result.events?.[3]).not.toHaveProperty('location');
});

it('distinguishes missing equipment from unrelated records and invalid clocks', () => {
  expect(() => parseTracking(fixture('missing'), 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(movements, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(movements.replace('11:27:10', '25:27:10'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
