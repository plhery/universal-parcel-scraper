import { describe, expect, it } from 'vitest';
import { FeibaoTracker } from './adapter.js';

const positive = process.env.FEIBAO_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.FEIBAO_LOGISTICS_UNKNOWN_NUMBER;
const tracker = new FeibaoTracker();

describe('feibao-logistics live guest retrieval', () => {
  it.skipIf(!positive)('reads history with instants for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && !event.local_time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/\*\*|司机|1[3-9]\d{9}/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
