import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const { PINOY_PRIDE_TRACKING_NUMBER: number, PINOY_PRIDE_MISSING_NUMBER: missing } = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns dated movements for the exact published freight invoice', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(1);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
}, 22_000);

it.skipIf(!missing)('honors the carrier’s native missing response for its other example', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 22_000);
