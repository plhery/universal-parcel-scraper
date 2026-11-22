import { describe, expect, it } from 'vitest';
import { LedaTracker } from './adapter.js';

const positive = process.env.LEDA_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.LEDA_EXPRESS_UNKNOWN_NUMBER;
const tracker = new LedaTracker();

describe('leda-express live guest retrieval', () => {
  it.skipIf(!positive)('reads the waybill\'s rows on China\'s wall clock', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)) && !event.time && event.description)).toBe(true);
    expect(result.events!.at(-1)!.stage).toBeDefined();
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
