import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const positive = process.env.KING_SOLUTIONS_TRACKING_NUMBER;
const unknown = process.env.KING_SOLUTIONS_UNKNOWN_NUMBER;
const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('King Solutions live retrieval', () => {
  it.skipIf(!positive)('reads the public tracking history', async () => {
    expect((await tracker.track({ number: positive! })).events?.length).toBeGreaterThan(0);
  }, 20_000);
  it.skipIf(!unknown)('reports a missing shipment', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});
