import { describe, expect, it } from 'vitest';
import { WhwdtTracker } from './adapter.js';

describe('Wuhan Wodetong live retrieval', () => {
  it.skipIf(!process.env.WHWDT_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new WhwdtTracker().fetch(process.env.WHWDT_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.WHWDT_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    // The tenant answers a lookup that closely follows another with "too busy".
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(new WhwdtTracker().fetch(process.env.WHWDT_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
