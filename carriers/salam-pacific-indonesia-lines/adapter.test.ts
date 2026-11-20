import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const movements = fixture('movements');
const number = numbers.records[0]!.number;

it('reads the SPIL history after a guest form search for the container', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(movements));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number: number.toLowerCase() });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://myspil.com/Front/tracktrace', expect.objectContaining({ method: 'POST' }));
  expect(new URLSearchParams(fetcher.mock.calls[0]?.[1]?.body?.toString()).get('blorcont')).toBe(number);
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Container Discharge from Vessel', last_update_local: '2026-10-18T09:05',
  });
  expect(result.events).toHaveLength(9);
  expect(result.events?.[7]).not.toHaveProperty('stage');
  expect(result.events?.[8]).toMatchObject({ description: 'Booking Requested', stage: 'registered' });
});

it('distinguishes an exact empty result and rejects an unrelated container or invalid date', () => {
  expect(() => parseTracking(fixture('missing'), 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(movements, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(movements.replace('18/10/2026', '32/10/2026'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
