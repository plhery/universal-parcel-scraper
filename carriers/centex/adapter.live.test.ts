import { describe, expect, it } from 'vitest';
import { CentexTracker } from './adapter.js';

// A waybill in CENTEX's layout that names no parcel.
const UNKNOWN = process.env.CENTEX_UNKNOWN_NUMBER ?? 'ZJ00000000000000017';

describe('CENTEX live retrieval', () => {
  it.skipIf(!process.env.CENTEX_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new CentexTracker().fetch(process.env.CENTEX_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // The tracker states no offset, so every scan keeps its wall clock.
    expect(result.events!.every((event) => event.description && event.local_time && !event.time)).toBe(true);
  }, 30_000);

  it('reads the tracker’s answer for a number it does not hold as not found', async () => {
    await expect(new CentexTracker().fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
