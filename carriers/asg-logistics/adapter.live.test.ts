import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { ASG_LOGISTICS_TRACKING_NUMBER: found, ASG_LOGISTICS_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads an exact ASG Logistics summary without a lookup timestamp', async () => {
  const result = await tracker.track({ number: found! });
  expect(result).toMatchObject({ summary_only: true, last_status_text: expect.any(String), events: [] });
  expect(result.last_update).toBeUndefined();
}, 35_000);

it.skipIf(!unknown)('recognizes ASG’s no-result reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 35_000);
