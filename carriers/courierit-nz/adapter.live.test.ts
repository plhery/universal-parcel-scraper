import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.COURIERIT_NZ_TRACKING_NUMBER;

it.skipIf(!number)('tracks an indexed Courierit New Zealand consignment', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'courierit-nz' });
  expect(answer.source).toBe('courierit-nz');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
