import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
const positive = process.env.OTS_ASTRACON_TRACKING_NUMBER;
const unknown = process.env.OTS_ASTRACON_UNKNOWN_NUMBER;

describe('O.T.S. ASTRACON live guest tracking', () => {
  it.skipIf(!positive)('reads dated shipment events for a public house bill', async () => {
    const result = await tracker.track({ number: positive! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && event.time?.endsWith('Z'))).toBe(true);
  });

  it.skipIf(!unknown)('returns the native shipment miss for an unmatched public freight reference', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
