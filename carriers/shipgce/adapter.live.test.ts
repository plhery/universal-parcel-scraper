import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.SHIPGCE_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected waybill through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'shipgce' });
  expect(answer.source).toBe('shipgce');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
