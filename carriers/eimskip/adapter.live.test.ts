import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { EIMSKIP_TRACKING_NUMBER: found, EIMSKIP_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns the requested shipment milestones', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the carrier’s empty shipment search', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
