import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.PRESSEX_TRACKING_NUMBER;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('reads the official PressEx public guide and its dated milestone history', async () => {
  const result = await tracker.track({ number: number! });

  expect(result.current_stage).toBe('delivered');
  expect(result.last_status_text).toBe('ENTREGADO');
  expect(result.last_update_local).toBe('2021-07-01T19:52:00');
  expect(result.events?.length).toBeGreaterThanOrEqual(5);
}, 20_000);
