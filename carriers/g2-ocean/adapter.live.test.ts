import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { G2_OCEAN_TRACKING_NUMBER: found, G2_OCEAN_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns the requested bill port calls', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the carrier’s missing bill reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
