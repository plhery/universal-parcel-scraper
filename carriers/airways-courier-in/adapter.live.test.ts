import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.AIRWAYS_COURIER_IN_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected consignment through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'airways-courier-in' });
  expect(answer.source).toBe('airways-courier-in');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
