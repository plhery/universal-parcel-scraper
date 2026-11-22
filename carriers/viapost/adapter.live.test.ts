import { describe, expect, it } from 'vitest';
import { ViapostTracker } from './adapter.js';

const positive = process.env.VIAPOST_TRACKING_NUMBER;
const unknown = process.env.VIAPOST_UNKNOWN_NUMBER;
const tracker = new ViapostTracker();

describe('viapost live guest retrieval', () => {
  it.skipIf(!positive)('reads the dated statuses of the whole order', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 20_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && !event.time
      && event.description === event.provider_code)).toBe(true);
    expect(result.events!.at(-1)!.stage).toBeDefined();
    // The recipient's phone, in the page and its notices, is never read.
    expect(JSON.stringify(result)).not.toMatch(/\d{6,}|Viber/);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown order as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
