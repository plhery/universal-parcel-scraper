import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

describe('Emile live provider retrieval', () => {
  it.skipIf(!process.env.EMILE_TRACKING_NUMBER)('retrieves the history of a number filed under Emile through an enabled provider', async () => {
    const answer = await createTracker({ providers: ['ParcelsApp'] }).track({ number: process.env.EMILE_TRACKING_NUMBER!, carrier: 'emile' });
    expect(answer.carrier).toBe('emile');
    expect(answer.source).toBe('ParcelsApp');
    expect(answer.result.events.length).toBeGreaterThan(0);
  });
});
