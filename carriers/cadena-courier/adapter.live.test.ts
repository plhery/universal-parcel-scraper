import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const { CADENA_COURIER_TRACKING_NUMBER: number, CADENA_COURIER_MISSING_NUMBER: missing } = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('finds the exact Cadena Courier guide and reads its dated movements', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}/);
}, 25_000);

it.skipIf(!missing)('reports a published guide currently absent from its search grid', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 25_000);
