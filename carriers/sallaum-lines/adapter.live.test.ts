import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SALLAUM_LINES_TRACKING_NUMBER: found, SALLAUM_LINES_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns dated movements for the published vehicle serial', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('recognizes the tracking service’s missing vehicle reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
