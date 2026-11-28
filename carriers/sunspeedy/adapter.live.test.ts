import { afterAll, describe, expect, it } from 'vitest';
import { SunspeedyTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

// The public sample, unless another is given.
const NUMBER = process.env.SUNSPEEDY_TRACKING_NUMBER ?? numbers.records[0]!.number;
const tracker = new SunspeedyTracker();
afterAll(() => tracker.close());

describe('Sunspeedy live retrieval', () => {
  it('reads the verify code and the rows of the whole waybill', async () => {
    const result = await tracker.fetch(NUMBER, { budgetMs: 40_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.local_time)).toBe(true);
  }, 60_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.SUNSPEEDY_UNKNOWN_NUMBER ?? 'ZZ314159265HK';
    await expect(tracker.fetch(unknown, { budgetMs: 40_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
