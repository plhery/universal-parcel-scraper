import { describe, expect, it } from 'vitest';
import { FrontierCaTracker } from './adapter.js';
describe('frontier-ca live retrieval', () => {
  it.skipIf(!process.env.FRONTIER_CA_TRACKING_NUMBER)('reads the verified guest scope', async () => {
    const result = await new FrontierCaTracker().fetch(process.env.FRONTIER_CA_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0); expect(result.events!.every(event => event.local_time)).toBe(true);
  });
  it.skipIf(!process.env.FRONTIER_CA_UNKNOWN_NUMBER)('keeps its absence kind', async () => {
    await expect(new FrontierCaTracker().fetch(process.env.FRONTIER_CA_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
