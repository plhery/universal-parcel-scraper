import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const positive = process.env.BM_CARGO_TRACKING_NUMBER;
const unknown = process.env.BM_CARGO_UNKNOWN_NUMBER;

describe('BM Cargo live guest retrieval', () => {
  it.skipIf(!positive)('reads dated scans for the requested receipt', async () => {
    const result = await tracker.track({ number: positive! }, {});
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && event.description)).toBe(true);
  });
  it.skipIf(!unknown)('preserves an empty form as an inconclusive answer', async () => {
    await expect(tracker.track({ number: unknown! }, {})).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
