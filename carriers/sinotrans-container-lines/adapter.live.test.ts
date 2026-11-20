import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const {
  SINOTRANS_CONTAINER_LINES_TRACKING_NUMBER: found,
  SINOTRANS_CONTAINER_LINES_UNKNOWN_NUMBER: unknown,
} = process.env;

it.skipIf(!found)('tracks the published Sinotrans container through the guest form', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]?.local_time).toBeTruthy();
}, 45_000);

it.skipIf(!unknown)('recognizes the native no-data message', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 45_000);
