import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const history = fixture('port-calls');
const number = numbers.records[0]!.number;
const bill = number.slice(4);

it('opens the public bill search and preserves actual port calls for the matching bill', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://api.myg2.g2ocean.com/api/public-bol-shipment?bol_name=${bill}`, expect.any(Object));
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Berthed', last_update_local: '2026-10-25T01:30',
  });
  expect(result.events).toHaveLength(5);
  expect(result.events?.[0]).toMatchObject({ location: 'Houston', stage: 'in_transit' });
  expect(result.events?.[2]).toMatchObject({ description: 'Departed', location: 'Mumbai', stage: 'in_transit' });
  expect(result.events?.[3]).not.toHaveProperty('stage');
});

it('distinguishes missing bills, unrelated bills and future calls', () => {
  expect(() => parseTracking(fixture('missing'), bill, 422)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, 'ZZZ00000Z', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history.replaceAll('"happened": true', '"happened": false'), bill, 200))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
