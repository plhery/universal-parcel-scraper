import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { AIRBALTIC_CARGO_TRACKING_NUMBER: found, AIRBALTIC_CARGO_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns airBaltic’s public air waybill history', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
});
it.skipIf(!unknown)('recognizes the carrier’s matching no-result page', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
