import { describe, expect, it } from 'vitest';
import { FreightwaysGlobalTracker } from './adapter.js';
describe('freightways-global live retrieval', () => {
  it.skipIf(!process.env.FREIGHTWAYS_GLOBAL_TRACKING_NUMBER)('reads the verified guest scope', async () => {
    const result = await new FreightwaysGlobalTracker().fetch(process.env.FREIGHTWAYS_GLOBAL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0); expect(result.events!.every(event => event.local_time)).toBe(true);
  });
  it.skipIf(!process.env.FREIGHTWAYS_GLOBAL_UNKNOWN_NUMBER)('keeps its absence kind', async () => {
    await expect(new FreightwaysGlobalTracker().fetch(process.env.FREIGHTWAYS_GLOBAL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
