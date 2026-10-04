import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('OMGO live provider retrieval', () => {
  it.skipIf(!process.env.OMGO_TRACKING_NUMBER)('detects OMGO and retrieves its history through an enabled provider', async () => {
    const answer = await createTracker({ providers: ['ParcelsApp'] }).track({ number: process.env.OMGO_TRACKING_NUMBER! });
    expect(answer.carrier).toBe('omgo');
    expect(answer.source).toBe('ParcelsApp');
    expect(answer.result.events.length).toBeGreaterThan(0);
  });
});
