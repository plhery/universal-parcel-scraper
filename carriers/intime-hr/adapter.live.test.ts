import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.INTIME_HR_TRACKING_NUMBER;

it.skipIf(!number)('reads the history of an In Time Croatia shipment', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/), description: expect.any(String) });
}, 20_000);
