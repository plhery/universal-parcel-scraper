import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { ENVIAMOS_COMUNICACIONES_TRACKING_NUMBER: found, ENVIAMOS_COMUNICACIONES_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('finds dated events for the full Enviamos guide', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('confirms the carrier’s guide-not-found response', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
