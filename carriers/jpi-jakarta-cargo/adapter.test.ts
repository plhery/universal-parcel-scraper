import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const history = fixture('history');

it('reads the dated history for the exact JPI shipment', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://tracker.v2.jpicargo.com/api/search?no_resi=${number}`,
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }));
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'DELIVERED', last_update_local: '2025-11-19T14:45:31',
  });
  expect(result.events).toHaveLength(9);
  expect(result.events?.find(event => event.provider_code === 'RECEIVED JPI')).toMatchObject({ stage: 'accepted' });
  expect(result.events?.find(event => event.provider_code === 'PICKUP')).not.toHaveProperty('stage');
});

it('distinguishes empty results and scans from a different shipment', () => {
  expect(() => parseTracking(fixture('missing'), 'KJ0000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, 'KJ0000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history.replace('"resi_id": 1', '"resi_id": 2'), number))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
