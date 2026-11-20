import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const {
  CORDELIA_SHIPPING_TRACKING_NUMBER: bill,
  CORDELIA_SHIPPING_CONTAINER_NUMBER: container,
  CORDELIA_SHIPPING_UNKNOWN_BILL: unknown,
} = process.env;

it.skipIf(!bill)('returns the requested Cordelia bill movements', async () => {
  expect((await tracker.track({ number: bill! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!container)('returns the requested Cordelia container movements', async () => {
  expect((await tracker.track({ number: container! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the carrier’s empty bill search', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
