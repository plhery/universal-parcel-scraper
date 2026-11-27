import { afterAll, describe, expect, it } from 'vitest';
import { HainanCargoTracker } from './adapter.js';

const positive = process.env.HAINAN_AIRLINES_CARGO_TRACKING_NUMBER;
const unknown = process.env.HAINAN_AIRLINES_CARGO_UNKNOWN_NUMBER;
const tracker = new HainanCargoTracker();
afterAll(() => tracker.close());

describe('hainan-airlines-cargo live guest retrieval', () => {
  it.skipIf(!positive)('reads the verify code and the scans of the whole air waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 40_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.local_time && !event.time && event.description)).toBe(true);
  }, 60_000);
  it.skipIf(!unknown)('reports an unknown air waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 40_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
