import { describe, expect, it } from 'vitest';
import { SheensyncTracker } from './adapter.js';

describe('SheenSync live retrieval', () => {
  it.skipIf(!process.env.SHEENSYNC_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new SheensyncTracker().fetch(process.env.SHEENSYNC_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.SHEENSYNC_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(new SheensyncTracker().fetch(process.env.SHEENSYNC_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
