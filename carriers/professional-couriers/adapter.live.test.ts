import { afterAll, describe, expect, it } from 'vitest';
import { ProfessionalCouriersTracker } from './adapter.js';

const positive = process.env.PROFESSIONAL_COURIERS_TRACKING_NUMBER;
const unknown = process.env.PROFESSIONAL_COURIERS_UNKNOWN_NUMBER;
const tracker = new ProfessionalCouriersTracker();
afterAll(() => tracker.close());

describe('professional-couriers live guest retrieval', () => {
  it.skipIf(!positive)('passes the captcha and the printed code and reads dated history for the whole number', async () => {
    const result = await tracker.fetch(positive!, { budgetMs: 45_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description && event.location)).toBe(true);
  }, 60_000);
  it.skipIf(!unknown)('reports an unknown consignment as not found', async () => {
    await expect(tracker.fetch(unknown!, { budgetMs: 45_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
