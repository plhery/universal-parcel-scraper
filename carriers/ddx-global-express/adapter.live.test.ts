import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.DDX_TRACKING_NUMBER;

it.skipIf(!number)('returns the carrier-published parcel’s current status', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBeDefined();
  expect(result.last_status_text).toBeTruthy();
}, 20_000);
