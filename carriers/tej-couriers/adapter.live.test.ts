import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('Tej Couriers live retrieval', () => {
  it.skipIf(!process.env.TEJ_COURIERS_TRACKING_NUMBER)('reads the selected consignment through the public SDK with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TEJ_COURIERS_TRACKING_NUMBER!, carrier: 'tej-couriers' });
    expect(answer).toMatchObject({ carrier: 'tej-couriers', source: 'tej-couriers' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);
});
