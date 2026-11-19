import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const positive = process.env.WALKER_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.WALKER_LOGISTICS_UNKNOWN_NUMBER;
const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('Walker Logistics live retrieval', () => {
  it.skipIf(!positive)('reads the public tracking history', async () => {
    expect((await tracker.track({ number: positive! })).events?.length).toBeGreaterThan(0);
  }, 20_000);
  it.skipIf(!unknown)('reports a missing shipment', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});
