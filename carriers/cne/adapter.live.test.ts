import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('CNE live provider retrieval', () => {
  it.skipIf(!process.env.CNE_TRACKING_NUMBER)('retrieves an explicitly selected shipment through an enabled provider', async () => {
    const answer = await createTracker({ providers: ['ParcelsApp'] }).track({ number: process.env.CNE_TRACKING_NUMBER!, carrier: 'cne' });
    expect(answer.carrier).toBe('cne');
    expect(answer.source).toBe('ParcelsApp');
    expect(answer.result.events.length).toBeGreaterThan(0);
  });
});
