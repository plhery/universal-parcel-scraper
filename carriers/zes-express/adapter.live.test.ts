import { describe, expect, it } from 'vitest';
import { ZesExpressTracker } from './adapter.js';

describe('ZES Express guest retrieval', () => {
  it.skipIf(!process.env.ZES_EXPRESS_TRACKING_NUMBER)('retrieves whole-bound native scans', async () => {
    const result = await new ZesExpressTracker().fetch(process.env.ZES_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.ZES_EXPRESS_UNKNOWN_NUMBER)('retains the exact guest missing reply', async () => {
    await expect(new ZesExpressTracker().fetch(process.env.ZES_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
