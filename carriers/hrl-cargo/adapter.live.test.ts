import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.HRL_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('returns the carrier’s published docket and actual branch movements', async () => {
  const tracking = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracking.track({ number: number! });
  expect(result.status).toBe('delivered');
  expect(result.events).toContainEqual(expect.objectContaining({ stage: 'delivered', local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
}, 25_000);
