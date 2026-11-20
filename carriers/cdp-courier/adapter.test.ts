import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { endpoint, parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const history = fixture('in-transit.json');

it('uses the guest form state to look up the courier reference', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(fixture('form.html')))
    .mockImplementationOnce(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://cdpcourier.com/', endpoint]);
  expect(fetcher.mock.calls[1]?.[1]?.body?.toString())
    .toBe(`action=cdp_tracking&security=0000000000&payload_data=${number}`);
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'In Transit to Destination', last_update_local: '2026-08-18T18:55:08',
  });
  expect(result.events).toHaveLength(2);
  expect(result.events?.every(event => event.location === 'Suva - FIJI')).toBe(true);
});

it('distinguishes an empty result from broken dated events', () => {
  expect(() => parseTracking(fixture('missing.json'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history.replace('2026/08/18', '2026/09/31'))).toThrow(expect.objectContaining({ kind: 'schema' }));
});
