import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SHREE_NANDAN_TRACKING_NUMBER: found, SHREE_NANDAN_UNKNOWN_NUMBER: missing } = process.env;

it.skipIf(!found)('reads the dated history of a shipment from the Connecting Nandan web view', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(1);
  expect(result.events?.every((event) => typeof event.local_time === 'string')).toBe(true);
});

it.skipIf(!missing)('reads the empty web view of an unknown number as not found', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
});
