import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
const positive = process.env.NAVLUNGO_TRACKING_NUMBER;
const unknown = process.env.NAVLUNGO_UNKNOWN_NUMBER;

describe('Navlungo live guest tracking', () => {
  it.skipIf(!positive)('reads dated scans for the matched delivery number', async () => {
    const result = await tracker.track({ number: positive! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && (event.time || event.local_time))).toBe(true);
  });

  it.skipIf(!unknown)('keeps the native shipment miss as not found', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
