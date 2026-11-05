import { describe, expect, it } from 'vitest';
import { VXpressTracker } from './adapter.js';
describe('V-Xpress guest docket live retrieval', () => {
  it.skipIf(!process.env.VXPRESS_TRACKING_NUMBER)('reads a whole bound docket history', async () => {
    const result = await new VXpressTracker().fetch(process.env.VXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0); expect(result.events!.every(event => event.local_time)).toBe(true);
  });
  it.skipIf(!process.env.VXPRESS_UNKNOWN_NUMBER)('keeps the explicit unknown separate', async () => {
    await expect(new VXpressTracker().fetch(process.env.VXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
