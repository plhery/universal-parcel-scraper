import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.GBS_BROKER_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected customs reference through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'gbs-broker' });
  expect(answer.source).toBe('gbs-broker');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
