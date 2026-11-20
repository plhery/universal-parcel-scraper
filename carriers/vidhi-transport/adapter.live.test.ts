import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { VIDHI_TRANSPORT_TRACKING_NUMBER: found, VIDHI_TRANSPORT_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads the confirmed lorry receipt’s current status', async () => {
  expect(await tracker.track({ number: found! })).toMatchObject({ summary_only: true, last_status_text: expect.any(String) });
});
it.skipIf(!unknown)('reads the carrier’s empty guest reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
