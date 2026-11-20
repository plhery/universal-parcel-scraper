import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { JET_DELIVERY_TRACKING_NUMBER: found, JET_DELIVERY_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('finds the full Jet Delivery number and dated events', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('recognizes the carrier’s invalid tracking number reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
