import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseFormState, parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const container = fixture('container');
const missing = fixture('missing');
const number = numbers.records[0]!.number;

it('shares the guest form timestamp with the bound container request', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, n: 'visitor-form-state' })))
    .mockImplementationOnce(async () => new Response(container));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });

  expect(fetcher).toHaveBeenCalledTimes(2);
  const state = new URL(String(fetcher.mock.calls[0]?.[0]));
  const lookup = new URL(String(fetcher.mock.calls[1]?.[0]));
  expect(state.pathname).toMatch(/\/common\/get-n\.php$/);
  expect(lookup.pathname).toMatch(/\/trackntrace-containertnt\.php$/);
  expect(state.searchParams.get('timestamp')).toMatch(/^\d+$/);
  expect(Object.fromEntries(lookup.searchParams)).toEqual({
    module: 'TrackContStatus', refNo: number, n: 'visitor-form-state', timestamp: state.searchParams.get('timestamp'),
  });
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'I/B Empty Container Returned', last_update_local: '2024-03-29T08:34:00',
  });
  expect(result.events).toHaveLength(6);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ location: 'NAVEGANTES', stage: 'in_transit' });
  expect(result.events?.[4]).toMatchObject({ location: 'SHEKOU', stage: 'accepted' });
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('binds successful and missing replies to the requested container', () => {
  expect(() => parseTracking(missing, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(missing, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseTracking(container, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseFormState('{"success":true}')).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseTracking('{"data":"Request Rejected. Your support ID is: 1"}', number))
    .toThrow(expect.objectContaining({ kind: 'challenge' }));
});
