import { describe, expect, it } from 'vitest';
import { XcargoTracker } from './adapter.js';
const number = process.env.XCARGO_TRACKING_NUMBER;
const unknown = process.env.XCARGO_UNKNOWN_NUMBER;
describe.skipIf(!number)('X-Cargo public group tracking', () => {
  it('reads a bound dated history', async () => {
    const result = await new XcargoTracker().fetch(number!, { budgetMs: 20_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(row => /[+-]\d{2}:\d{2}$/.test(row.time ?? ''))).toBe(true);
  });
  it.skipIf(!unknown)('recognizes the exact unknown reply', async () => {
    await expect(new XcargoTracker().fetch(unknown!, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
