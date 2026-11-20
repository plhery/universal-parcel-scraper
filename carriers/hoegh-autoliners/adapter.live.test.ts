import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { HOEGH_AUTOLINERS_TRACKING_NUMBER: found, HOEGH_AUTOLINERS_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns dated port movements for the full public bill', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('distinguishes the empty native result', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
