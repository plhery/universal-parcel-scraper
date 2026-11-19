import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const positive = process.env.MTE_XPRESS_TRACKING_NUMBER;
const unknown = process.env.MTE_XPRESS_UNKNOWN_NUMBER;
const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('MTE Xpress live retrieval', () => {
  it.skipIf(!positive)('reads the public tracking history', async () => {
    expect((await tracker.track({ number: positive! })).events?.length).toBeGreaterThan(0);
  }, 20_000);
  it.skipIf(!unknown)('reports a missing shipment', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});
