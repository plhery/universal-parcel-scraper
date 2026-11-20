import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { IGNAZIO_MESSINA_TRACKING_NUMBER: found, IGNAZIO_MESSINA_INVALID_NUMBER: invalid } = process.env;

it.skipIf(!found)('returns the requested container movements', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!invalid)('reads the carrier’s rejected check digit response', async () => {
  await expect(tracker.track({ number: invalid! })).rejects.toMatchObject({ kind: 'invalid_input' });
});
