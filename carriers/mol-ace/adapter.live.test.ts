import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { MOL_ACE_TRACKING_NUMBER: found, MOL_ACE_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns two timed port movements for the public bill', async () => {
  expect((await tracker.track({ number: found! })).events).toHaveLength(2);
});
it.skipIf(!unknown)('returns not found for an unissued bill', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
