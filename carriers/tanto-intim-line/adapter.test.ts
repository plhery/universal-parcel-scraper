import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const discharged = fixture('discharge');
const number = numbers.records[0]!.number;

it('uses the container form format and preserves day precision', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(discharged));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number: number.replace(/[\s-]+/g, '').toLowerCase() });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://sync.tantooffice.com/api/tcm/container_tracking', expect.objectContaining({ method: 'POST' }));
  expect(new URLSearchParams(fetcher.mock.calls[0]?.[1]?.body?.toString()).get('container')).toBe(number);
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'PORT OF DISCHARGING', last_update_local: '2026-11-02',
    events: [{ local_time: '2026-11-02', description: 'PORT OF DISCHARGING', stage: 'in_transit' }],
  });
});

it('keeps the actual on-board activity and rejects empty and mismatched results', () => {
  expect(parseTracking(fixture('vessel'), 'TAKU6078275')).toMatchObject({
    status: 'in_transit', last_status_text: 'ON SHIP - TANTO BAGUS', last_update_local: '2026-11-20',
  });
  expect(() => parseTracking(fixture('missing'), 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(discharged, 'TAKU6078275')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
