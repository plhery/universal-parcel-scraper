import { describe, expect, it } from 'vitest';
import { HgdTracker } from './adapter.js';

describe('HGD live retrieval', () => {
  it.skipIf(!process.env.HGD_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new HgdTracker().fetch(process.env.HGD_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.local_time)).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.HGD_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(new HgdTracker().fetch(process.env.HGD_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
