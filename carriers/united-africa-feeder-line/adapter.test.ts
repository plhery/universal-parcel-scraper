import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const history = fixture('history');

it('reads only dated container movements under the exact booking number', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://www.uaflshipping.com/Tracking?BookingNo=${number}`,
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html' }) }),
  );
  expect(result).toMatchObject({ status: 'unknown', last_status_text: 'RECEIVED EMPTY', last_update_local: '2026-04-07' });
  expect(result.events).toHaveLength(6);
  expect(result.events?.[0]?.stage).toBeUndefined();
  expect(result.events?.[1]).toMatchObject({ description: 'SENT TO CONSIGNEE', stage: 'in_transit', location: 'DURBAN, SOUTH AFRICA' });
  expect(result.events?.[4]?.stage).toBe('accepted');
});

it('keeps no-result pages, mismatched bookings and unfamiliar tables distinct', () => {
  expect(() => parseTracking(fixture('missing'), 'UAFLINVALID0')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, 'UAFLINVALID0')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history.replace('Chronological Container and Vessel Activities for Container', '').replace(
    '<strong>GAOU6376038</strong>', '<strong>ABCU0000000</strong>',
  ), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
