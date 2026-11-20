import { describe, expect, it } from 'vitest';
import { LerdexTracker } from './adapter.js';

describe('Lerdex live retrieval', () => {
  it.skipIf(!process.env.LERDEX_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new LerdexTracker().fetch(process.env.LERDEX_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.local_time)).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.LERDEX_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    // The API drops a lookup that closely follows another.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(new LerdexTracker().fetch(process.env.LERDEX_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 40_000);
});
