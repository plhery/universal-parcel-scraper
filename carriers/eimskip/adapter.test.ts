import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const discharge = fixture('discharged');
const number = numbers.records[0]!.number;
const shipment = number.slice(4);

it('submits the Eimskip number and keeps the dated shipment milestones', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(discharge));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://www.eimskip.com/find-shipment/?id=${shipment}`, expect.any(Object));
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Discharged from vessel', last_update_local: '2026-10-23T11:49',
  });
  expect(result.events?.map(({ description, stage }) => [description, stage])).toEqual([
    ['Discharged from vessel', 'in_transit'],
    ['Vessel arrived', 'in_transit'],
    ['Vessel departed', 'in_transit'],
    ['Booked', 'registered'],
  ]);
});

it('distinguishes empty, unrelated and malformed results', () => {
  expect(() => parseTracking(fixture('missing'), 'L00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(discharge, 'L00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(discharge.replace('23.10.2026', '32.10.2026'), shipment)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
