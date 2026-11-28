import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another waybill is given.
const number = process.env.OMG_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

it('reads the timeline of an OMG Express waybill', async () => {
  const result = await tracker.track({ number });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/), description: expect.any(String) });
}, 30_000);

it('reads an unknown waybill as not found', async () => {
  await expect(tracker.track({ number: 'OMG0000000000' })).rejects.toMatchObject({ kind: 'not_found' });
}, 30_000);
