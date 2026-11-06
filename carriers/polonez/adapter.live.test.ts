import { describe, expect, it } from 'vitest';
import { PolonezTracker } from './adapter.js';

describe('Polonez public guest retrieval', () => {
  it.skipIf(!process.env.POLONEZ_TRACKING_NUMBER)('reads a whole bound label history', async () => {
    const result = await new PolonezTracker().fetch(process.env.POLONEZ_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
  });
  it.skipIf(!process.env.POLONEZ_UNKNOWN_NUMBER)('keeps absent retained history inconclusive', async () => {
    await expect(new PolonezTracker().fetch(process.env.POLONEZ_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
