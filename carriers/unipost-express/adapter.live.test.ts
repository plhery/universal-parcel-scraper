import { describe, expect, it } from 'vitest';
import { UnipostTracker } from './adapter.js';

const positive = process.env.UNIPOST_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.UNIPOST_EXPRESS_UNKNOWN_NUMBER;
const tracker = new UnipostTracker();

describe('unipost-express live guest retrieval', () => {
  it.skipIf(!positive)('reads the history of the whole waybill on its wall clocks, without names', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description)).toBe(true);
    expect(result.events!.every(event => Object.keys(event).every(key => ['local_time', 'description', 'location', 'stage', 'stage_source'].includes(key)))).toBe(true);
    expect(result.destination_country).toMatch(/^[A-Z]{2}$/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
