import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { QATAR_AIRWAYS_CARGO_TRACKING_NUMBER: found, QATAR_AIRWAYS_CARGO_UNKNOWN_NUMBER: unknown } = process.env;
it.skipIf(!found)('returns real dated air waybill movements', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the guest search’s empty response', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
