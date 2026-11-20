import { describe, expect, it } from 'vitest';
import { XingyouTracker } from './adapter.js';

describe('Xingyou live retrieval', () => {
  it.skipIf(!process.env.XINGYOU_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new XingyouTracker().fetch(process.env.XINGYOU_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // Every row keeps its wall clock.
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.XINGYOU_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    // The tenant answers "service is busy" to a lookup sent right after another.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(new XingyouTracker().fetch(process.env.XINGYOU_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
