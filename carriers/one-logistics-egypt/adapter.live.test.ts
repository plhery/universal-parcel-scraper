import { expect, it } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.ONE_LOGISTICS_EGYPT_TRACKING_NUMBER;

it.skipIf(!number)('returns the exact published freight file and its closure status', async () => {
  const result = await tracker.track({ number: directTrackingNumber('one-logistics-egypt', number!) });
  expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Closed File', summary_only: true });
  expect(result.last_update).toBeUndefined();
}, 20_000);
