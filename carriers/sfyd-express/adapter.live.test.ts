import { describe, expect, it } from 'vitest';
import { SfydTracker } from './adapter.js';

describe('SFYD Express live retrieval', () => {
  it.skipIf(!process.env.SFYD_EXPRESS_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new SfydTracker().fetch(process.env.SFYD_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // SFYD's own scans state China's offset.
    expect(result.events!.some((event) => event.time?.endsWith('+08:00'))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.SFYD_EXPRESS_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(new SfydTracker().fetch(process.env.SFYD_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
