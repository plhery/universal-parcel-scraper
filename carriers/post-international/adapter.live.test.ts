import { describe, expect, it } from 'vitest';
import { PostIntTracker } from './adapter.js';

const positive = process.env.POST_INTERNATIONAL_TRACKING_NUMBER;
const unknown = process.env.POST_INTERNATIONAL_UNKNOWN_NUMBER;
const tracker = new PostIntTracker();

describe('post-international live guest retrieval', () => {
  it.skipIf(!positive)('reads the history of the shipment whose heading repeats the whole number', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(result.status).not.toBe('unknown');
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown number as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
