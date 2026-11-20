import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const movements = fixture('movements');

it('tracks exact Sea Legend equipment and deduplicates the actual movement log', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(movements));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.slg-shipping.com/slg-sealegend-rest/containerDynamicForWeb/list.do',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ bkgNo: number }) }),
  );
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'EMPTY RETURN', last_update_local: '2026-10-18T12:00:00' });
  expect(result.events).toHaveLength(10);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ provider_code: 'ID', location: 'ADEN', stage: 'in_transit' });
});

it('distinguishes an empty search from a different container and an invalid clock', () => {
  expect(() => parseTracking(fixture('missing'), 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(movements, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(movements.replace('2026-10-18 12:00:00', '2026-10-18 25:00:00'), number))
    .toThrow(expect.objectContaining({ kind: 'schema' }));
});
