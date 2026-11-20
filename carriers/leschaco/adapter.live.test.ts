import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { LESCHACO_TRACKING_NUMBER: found, LESCHACO_UNKNOWN_NUMBER: missing } = process.env;

it.skipIf(!found)('reads actual freight movements for a published Leschaco bill', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(1);
});
it.skipIf(!missing)('classifies the empty anonymous search reply', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
});
