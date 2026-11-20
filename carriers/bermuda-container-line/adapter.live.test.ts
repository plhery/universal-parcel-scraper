import { expect, it } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const container = process.env.BCL_TRACKING_CONTAINER;
const booking = process.env.BCL_TRACKING_BOOKING;
const missing = process.env.BCL_TRACKING_MISSING;

it.skipIf(!container)('finds dated Bermuda Container Line equipment movements', async () => {
  const result = await tracker.track({ number: directTrackingNumber('bermuda-container-line', container!) });
  expect(result.events?.some(event => event.local_time && event.description)).toBe(true);
}, 20_000);

it.skipIf(!booking)('finds public Bermuda Container Line booking movements', async () => {
  const result = await tracker.track({ number: booking! });
  expect(result.events?.some(event => event.local_time && event.description)).toBe(true);
}, 20_000);

it.skipIf(!missing)('recognizes the native no-match response', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
