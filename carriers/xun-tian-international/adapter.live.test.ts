import { describe, expect, it } from 'vitest';
import { XunTianTracker } from './adapter.js';

describe('Xun Tian International live retrieval', () => {
  it.skipIf(!process.env.XUN_TIAN_INTERNATIONAL_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new XunTianTracker().fetch(process.env.XUN_TIAN_INTERNATIONAL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.XUN_TIAN_INTERNATIONAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    // The tenant answers a lookup that closely follows another with "too busy".
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(new XunTianTracker().fetch(process.env.XUN_TIAN_INTERNATIONAL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
