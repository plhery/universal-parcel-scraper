import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SALAM_PACIFIC_INDONESIA_LINES_TRACKING_NUMBER: found, SALAM_PACIFIC_INDONESIA_LINES_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns the requested container movements', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the carrier’s empty movement search', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
