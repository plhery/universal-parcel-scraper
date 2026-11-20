import { describe, expect, it } from 'vitest';
import { DpdexTracker } from './adapter.js';

describe('DpdEx live retrieval', () => {
  it.skipIf(!process.env.DPDEX_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new DpdexTracker().fetch(process.env.DPDEX_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.DPDEX_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(new DpdexTracker().fetch(process.env.DPDEX_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
