import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SENDBOX_ARGENTINA_TRACKING_NUMBER: found, SENDBOX_ARGENTINA_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('returns the status of the carrier’s public SendBox guide', async () => {
  await expect(tracker.track({ number: found! })).resolves.toMatchObject({ status: 'delivered', summary_only: true });
});
it.skipIf(!unknown)('recognizes the carrier’s empty guide reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
});
