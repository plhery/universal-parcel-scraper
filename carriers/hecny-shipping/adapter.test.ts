import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTrackingPage } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const unprefixed = number.slice(4);
const bill = fixture('bill');
const transshipment = fixture('transshipment');
const missing = fixture('missing');

it('loads the exact house bill and orders the actual movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bill));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://www.hecny.com/en/track-and-trace?keyword=${unprefixed}`, expect.anything());
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', last_status_text: 'OUT GATE', last_update_local: '2026-11-17T09:52:00',
  });
  expect(result.events).toHaveLength(7);
  expect(result.events?.[0]).toMatchObject({ location: 'Los Angeles', provider_code: 'OA', stage: 'in_transit' });
  expect(result.events?.[6]).toMatchObject({ location: 'Qingdao', provider_code: 'EE' });
  expect(result.events?.[6]).not.toHaveProperty('stage');
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('keeps the port gate movements of a transshipment in transit', () => {
  const result = parseTrackingPage(transshipment, numbers.records[1]!.number.slice(4));
  const ningboGates = result.events?.filter(event => event.location === 'Ningbo' && event.description?.endsWith('GATE'));
  expect(ningboGates).toHaveLength(2);
  expect(ningboGates?.map(event => event.stage)).toEqual(['in_transit', 'in_transit']);
});

it('requires the searched reference and a whole house bill match', () => {
  expect(() => parseTrackingPage(missing, 'ZZZZ99999999')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTrackingPage(missing, unprefixed)).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseTrackingPage(bill.replace('FTAO10260472', 'FTAO10260473'), unprefixed))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTrackingPage('<title>Security Check</title>', unprefixed))
    .toThrow(expect.objectContaining({ kind: 'challenge' }));
});
