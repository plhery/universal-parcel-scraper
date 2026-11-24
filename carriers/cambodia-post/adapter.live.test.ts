import { describe, expect, it } from 'vitest';
import { CambodiaPostTracker } from './adapter.js';

const positive = process.env.CAMBODIA_POST_TRACKING_NUMBER;
const unknown = process.env.CAMBODIA_POST_UNKNOWN_NUMBER;
const tracker = new CambodiaPostTracker();

describe('cambodia-post live guest retrieval', () => {
  it.skipIf(!positive)('reads dated history for the whole item code', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(result.events!.some(event => /sign by/i.test(event.description ?? ''))).toBe(false);
    expect(result.current_stage).toBeDefined();
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown item code as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
