import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.INTERLOGISTICA_TRACKING_NUMBER;

it.skipIf(!number)('reads the requested shipment’s live history', async () => {
  const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER }).track({ number: number! }, { budgetMs: 15_000 });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.every(event => (event.time || event.local_time) && event.description)).toBe(true);
}, 20_000);
