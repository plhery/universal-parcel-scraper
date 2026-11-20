import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { GARDEWINE_TRACKING_NUMBER: found, GARDEWINE_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns the requested shipment movements', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('rejects an unbound result', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'indeterminate' });
});
