import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.TPL_KOREA_TRACKING_NUMBER;

it.skipIf(!number)('returns a completed progress stage for the FAQ’s waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.last_status_text).toBeTruthy();
  expect(result.summary_only).toBe(true);
});
