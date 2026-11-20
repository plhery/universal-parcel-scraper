import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { HEDE_SHIPPING_TRACKING_NUMBER: found, HEDE_SHIPPING_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads dated movements for the published Hede container', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
}, 35_000);

it.skipIf(!unknown)('returns not-found for the carrier’s empty search result', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 35_000);
