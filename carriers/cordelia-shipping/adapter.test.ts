import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const bill = numbers.records[0]!.number;
const equipment = numbers.records[1]!.number;

it.each([
  ['bill', bill, 'app/bltracking/bltracingweb?blno=', '2026-10-08T06:10'],
  ['container', equipment, 'api/byContainer/websearchContainerDtl?contno=', '2026-07-19T09:07'],
])('checks the exact %s and keeps its actual equipment movements', async (name, number, endpoint, latest) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture(name)));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://erp.cordelialine.com/cordelia/${endpoint}${number}`, expect.any(Object),
  );
  expect(result).toMatchObject({
    last_status_text: 'Empty container received from consignee', last_update_local: latest, status: 'in_transit',
  });
  expect(result.events?.map(event => event.provider_code)).toEqual(['RVC', 'STC', 'DHF']);
  expect(result.events?.[0]).not.toHaveProperty('stage');
});

it('distinguishes a missing bill, a rejected container and a reference mismatch', () => {
  expect(() => parseTracking(fixture('missing-bill'), bill, false)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('invalid-container'), equipment, true)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  expect(() => parseTracking(fixture('bill'), equipment, false)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(parseTracking(fixture('bill').replace('"noOfCon": 1', '"noOfCon": 2'), bill, false))
    .toMatchObject({ summary_only: true, events: [], last_status_text: 'Empty container received from consignee' });
});
