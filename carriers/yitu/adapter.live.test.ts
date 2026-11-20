import { describe, expect, it } from 'vitest';
import { YituTracker } from './adapter.js';

describe('YITU live retrieval', () => {
  it.skipIf(!process.env.YITU_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new YituTracker().fetch(process.env.YITU_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // Every row keeps its wall clock.
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.YITU_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    // The platform answers "service is busy" to a lookup sent right after another.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(new YituTracker().fetch(process.env.YITU_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
