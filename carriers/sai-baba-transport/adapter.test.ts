import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import history from './fixtures/history.json' with { type: 'json' };
import missing from './fixtures/missing.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('looks up the precise receipt and keeps day-first movement dates at their original precision', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://www.saibabatransport.com/api/track?lr=${number}`,
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }));
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'DELIVERED BY SIWAN', last_update_local: '2026-08-31' });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'DELIVERY', location: 'SIWAN', local_time: '2026-08-31' });
  expect(result.events?.find(event => event.provider_code === 'TRANSIT')).toMatchObject({
    description: 'On-Way Transit Toward SIWAN', local_time: '2026-07-14',
  });
  expect(result.events?.[0]?.time).toBeUndefined();
});

it('requires an exact receipt even when the native result is empty', () => {
  expect(() => parseTracking(JSON.stringify(missing), '00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(JSON.stringify(missing), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(JSON.stringify(history), '00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
