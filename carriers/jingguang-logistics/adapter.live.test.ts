import { describe, expect, it } from 'vitest';
import { JingguangTracker } from './adapter.js';

const positive = process.env.JINGGUANG_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.JINGGUANG_LOGISTICS_UNKNOWN_NUMBER;
const tracker = new JingguangTracker();

describe('jingguang-logistics live guest retrieval', () => {
  it.skipIf(!positive)('reads dated history for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/电话|如有疑问|\d{7,}/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
