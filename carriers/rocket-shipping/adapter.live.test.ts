import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.ROCKET_SHIPPING_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected load through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'rocket-shipping' });
  expect(answer.source).toBe('rocket-shipping');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
