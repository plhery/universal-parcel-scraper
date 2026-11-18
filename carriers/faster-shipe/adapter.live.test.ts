import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { FASTER_SHIPE_TRACKING_NUMBER: found, FASTER_SHIPE_UNKNOWN_NUMBER: unknown } = process.env;
it.skipIf(!found)('reads a public shipment', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.last_status_text).toBeTruthy();
});
it.skipIf(!unknown)('reads the absence reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
