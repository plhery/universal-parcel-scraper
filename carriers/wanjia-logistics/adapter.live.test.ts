import { describe, expect, it } from 'vitest';
import { WanjiaTracker } from './adapter.js';

const positive = process.env.WANJIA_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.WANJIA_LOGISTICS_UNKNOWN_NUMBER;
const tracker = new WanjiaTracker();

describe('wanjia-logistics live guest retrieval', () => {
  it.skipIf(!positive)('reads dated history for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/电话|取件码|揽收人|快递员\p{Script=Han}{2,4}送达|1[3-9]\d{9}/u);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
