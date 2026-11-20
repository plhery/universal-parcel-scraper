import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { CONFIRMED_FREIGHT_TRACKING_NUMBER: found, CONFIRMED_FREIGHT_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns dated movements for the official shipment demonstration', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('recognizes the carrier’s reference-specific missing shipment response', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
