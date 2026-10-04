import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('Sagawa live provider retrieval', () => {
  it.skipIf(!process.env.SAGAWA_TRACKING_NUMBER)('retrieves an explicitly selected shipment through an enabled provider', async () => {
    const answer = await createTracker({ providers: ['ParcelsApp'] }).track({ number: process.env.SAGAWA_TRACKING_NUMBER!, carrier: 'sagawa' });
    expect(answer.carrier).toBe('sagawa');
    expect(answer.source).toBe('ParcelsApp');
    expect(answer.result.events.length).toBeGreaterThan(0);
  });
});
