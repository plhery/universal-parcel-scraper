import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const history = fixture('history');

it('binds dated milestones to the exact Kenya Airways air waybill', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://cargotrackapi.kenya-airways.com/AWBTracking',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ awbNo: number }) }));
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Departed from DSS', last_update_local: '2023-08-08T21:04' });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'DEP', location: 'DSS', stage: 'in_transit' });
  expect(result.events?.[1]).not.toHaveProperty('stage');
});

it('distinguishes empty results and a milestone for another serial', () => {
  expect(() => parseTracking(fixture('missing'), '706-00000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, '706-00000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const other = history.replace(/("awbNo": )"50587725"(,\s+"action")/, '$1"OTHER"$2');
  expect(() => parseTracking(other, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
