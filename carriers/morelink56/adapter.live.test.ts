import { afterAll, describe, expect, it } from 'vitest';
import { MorelinkTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

// The public sample, unless another is given.
const NUMBER = process.env.MORELINK56_TRACKING_NUMBER ?? numbers.records[0]!.number;
const tracker = new MorelinkTracker();
afterAll(() => tracker.close());

describe('MoreLink live retrieval', () => {
  it('reads the verify code and the rows of the whole order', async () => {
    const result = await tracker.fetch(NUMBER, { budgetMs: 40_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/podfile|picture|https?:/);
  }, 60_000);

  it('reads an unknown order as not found', async () => {
    const unknown = process.env.MORELINK56_UNKNOWN_NUMBER ?? '314159265358979';
    await expect(tracker.fetch(unknown, { budgetMs: 40_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
