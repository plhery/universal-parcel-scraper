import { afterAll, describe, expect, it } from 'vitest';
import { PadtfTracker } from './adapter.js';

const positive = process.env.PADTF_TRACKING_NUMBER;
const unknown = process.env.PADTF_UNKNOWN_NUMBER;
const tracker = new PadtfTracker();
afterAll(() => tracker.close());

describe('padtf live guest retrieval', () => {
  it.skipIf(!positive)('solves the captcha and reads dated history for the whole waybill', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 40_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/电话|\d{7,}/);
  }, 60_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 40_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
