import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { HECNY_SHIPPING_TRACKING_NUMBER: found, HECNY_SHIPPING_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads Hecny movements for the requested house bill', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('reads the carrier’s bound empty result', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
