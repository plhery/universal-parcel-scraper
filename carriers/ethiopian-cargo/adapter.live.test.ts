import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { ETHIOPIAN_CARGO_TRACKING_NUMBER: found, ETHIOPIAN_CARGO_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns history for the submitted air waybill', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the official no-result response', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
