import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { DON_MARIANO_GUIDE_NUMBER: guide, DON_MARIANO_TRACKING_CODE: code } = process.env;

it.skipIf(!guide)('returns depot scan dates for the carrier’s guide example', async () => {
  const result = await tracker.track({ number: guide! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it.skipIf(!code)('finds the confirmed movements by the carrier’s tracking code', async () => {
  const result = await tracker.track({ number: code! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.some(event => event.description === 'Destino')).toBe(true);
});
