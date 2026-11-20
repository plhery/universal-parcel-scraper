import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { XANH_THL_TRACKING_NUMBER: found, XANH_THL_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('gets real movements for the published waybill', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
}, 40_000);
it.skipIf(!unknown)('handles the guest form’s missing-waybill reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 40_000);
