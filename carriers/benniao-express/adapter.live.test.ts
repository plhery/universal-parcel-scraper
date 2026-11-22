import { describe, expect, it } from 'vitest';
import { BenniaoTracker } from './adapter.js';

const positive = process.env.BENNIAO_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.BENNIAO_EXPRESS_UNKNOWN_NUMBER;
const tracker = new BenniaoTracker();

describe('benniao-express live guest retrieval', () => {
  it.skipIf(!positive)('reads history with local clocks for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/派件员|签收人|客服|1[3-9]\d{9}/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
