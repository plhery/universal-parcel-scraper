import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.SRI_COURIER_TRACKING_NUMBER;

it.skipIf(!number)('finds the current stage of the published SriCourier shipment', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.summary_only).toBe(true);
  expect(result.current_stage).toBeDefined();
}, 20_000);
