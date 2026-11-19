import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { VELOCITY_EXPRESS_IN_TRACKING_NUMBER: found, VELOCITY_EXPRESS_IN_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads the selected public shipment', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
});

it.skipIf(!unknown)('reads the explicit absence reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
