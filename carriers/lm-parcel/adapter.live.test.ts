import { describe, expect, it } from 'vitest';
import { LmParcelTracker } from './adapter.js';

describe('lm-parcel live retrieval', () => {
  it.skipIf(!process.env.LM_PARCEL_TRACKING_NUMBER)('reads dated guest history', async () => {
    const result = await new LmParcelTracker().fetch(process.env.LM_PARCEL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && (event.time || event.local_time))).toBe(true);
  });
  it.skipIf(!process.env.LM_PARCEL_UNKNOWN_NUMBER)('retains the exact absence signature', async () => {
    await expect(new LmParcelTracker().fetch(process.env.LM_PARCEL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
