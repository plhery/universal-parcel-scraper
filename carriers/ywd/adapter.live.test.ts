import { describe, expect, it } from 'vitest';
import { YwdTracker } from './adapter.js';

describe('YWD live retrieval', () => {
  it.skipIf(!process.env.YWD_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new YwdTracker().fetch(process.env.YWD_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // Every row keeps its wall clock.
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.YWD_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(new YwdTracker().fetch(process.env.YWD_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
