import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { PROCON_EXPRESS_LINES_TRACKING_NUMBER: found, PROCON_EXPRESS_LINES_UNKNOWN_NUMBER: missing } = process.env;

it.skipIf(!found)('reads the public consignment movements for a published house bill', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(1);
});
it.skipIf(!missing)('reads the public consignment absence message', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
});
