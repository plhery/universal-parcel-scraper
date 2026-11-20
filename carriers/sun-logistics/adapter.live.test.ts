import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.SUN_LOGISTICS_TRACKING_NUMBER;

it.skipIf(!number)('returns dock, local delivery and delivery-confirmation scans for the published PRO', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.description === 'Scanned On Dock')).toBe(true);
  expect(result.events?.some(event => event.stage === 'out_for_delivery')).toBe(true);
}, 20_000);
