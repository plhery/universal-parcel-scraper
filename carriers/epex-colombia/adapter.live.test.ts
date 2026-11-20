import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { EPEX_COLOMBIA_TRACKING_NUMBER: found, EPEX_COLOMBIA_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns exact EPEX guide with dated history', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('recognizes the carrier’s missing guide response', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
