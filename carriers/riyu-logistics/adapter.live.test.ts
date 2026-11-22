import { describe, expect, it } from 'vitest';
import { RiyuTracker } from './adapter.js';

const positive = process.env.RIYU_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.RIYU_LOGISTICS_UNKNOWN_NUMBER;
const tracker = new RiyuTracker();

describe('riyu-logistics live guest retrieval', () => {
  it.skipIf(!positive)('reads dated history for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/1[3-9]\d{9}|84666806/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
