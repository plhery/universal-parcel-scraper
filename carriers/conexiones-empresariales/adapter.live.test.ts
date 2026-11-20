import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.CONEXIONES_EMPRESARIALES_TRACKING_NUMBER;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns the exact public guide’s delivery and date', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.status).toBe('delivered');
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}, 20_000);
