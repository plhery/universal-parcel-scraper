import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.STOO_TRACKING_NUMBER;

it.skipIf(!number)('returns STOO warehouse, air transport and delivery scans', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'accepted')).toBe(true);
  expect(result.events?.some(event => event.provider_code === '100')).toBe(true);
  expect(result.events?.some(event => event.stage === 'delivered')).toBe(true);
}, 20_000);
