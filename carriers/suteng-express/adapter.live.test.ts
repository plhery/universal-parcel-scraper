import { describe, expect, it } from 'vitest';
import { SutengTracker } from './adapter.js';

const positive = process.env.SUTENG_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.SUTENG_EXPRESS_UNKNOWN_NUMBER;
const tracker = new SutengTracker();

describe('suteng-express live guest retrieval', () => {
  it.skipIf(!positive)('reads dated history for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/电话|签收人|\d{7,}/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
