import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
const positive = process.env.AIR_EUROPA_CARGO_TRACKING_NUMBER;
const unknown = process.env.AIR_EUROPA_CARGO_UNKNOWN_NUMBER;

describe('Air Europa Cargo live guest tracking', () => {
  it.skipIf(!positive)('reads dated operations for an echoed air waybill', async () => {
    const result = await tracker.track({ number: positive! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && event.local_time)).toBe(true);
  });

  it.skipIf(!unknown)('reports the native shipment miss', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
