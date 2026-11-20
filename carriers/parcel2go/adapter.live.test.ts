import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
const positive = process.env.PARCEL2GO_TRACKING_NUMBER;
const unknown = process.env.PARCEL2GO_UNKNOWN_NUMBER;

describe('Parcel2Go live guest tracking', () => {
  it.skipIf(!positive)('reads dated scans for the matched P2G reference', async () => {
    const result = await tracker.track({ number: positive! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && (event.time || event.local_time))).toBe(true);
  });

  it.skipIf(!unknown)('keeps the native order-line miss as not found', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
