import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SACO_SHIPPING_TRACKING_NUMBER: found, SACO_SHIPPING_UNKNOWN_NUMBER: missing } = process.env;

it.skipIf(!found)('reads the public history for a published SACO house bill', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(1);
});
it.skipIf(!missing)('classifies SACO’s explicit absence when the public tracker has no record', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
});
