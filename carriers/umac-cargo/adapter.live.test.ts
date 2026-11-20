import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const { UMAC_CARGO_TRACKING_NUMBER: number, UMAC_CARGO_MISSING_NUMBER: missing } = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns the exact box’s dated UMAC milestones', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(1);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}, 22_000);

it.skipIf(!missing)('honors the exact native negative reply for a published box number', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 22_000);
