import { describe, expect, it } from 'vitest';
import { QatarPostTracker } from './adapter.js';

describe('Qatar Post live retrieval', () => {
  it.skipIf(!process.env.QATAR_POST_TRACKING_NUMBER)('reads guest shipment history without browser verification', async () => {
    const result = await new QatarPostTracker().fetch(process.env.QATAR_POST_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0); expect(result.events?.every(e => e.local_time && e.description)).toBe(true);
  });
  it.skipIf(!process.env.QATAR_POST_UNKNOWN_NUMBER)('binds the explicit guest negative to the whole identifier', async () => {
    await expect(new QatarPostTracker().fetch(process.env.QATAR_POST_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
