import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { PASHA_HAWAII_CONTAINER_NUMBER: container, PASHA_HAWAII_BILL_NUMBER: bill } = process.env;

it.skipIf(!container)('returns dated movements for the public equipment number', async () => {
  const result = await tracker.track({ number: container! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

it.skipIf(!bill)('returns the dated port snapshot from its public bill inquiry', async () => {
  const result = await tracker.track({ number: bill! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
