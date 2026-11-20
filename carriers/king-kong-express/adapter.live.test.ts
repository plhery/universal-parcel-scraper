import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.KING_KONG_EXPRESS_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected waybill through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'king-kong-express' });
  expect(answer.source).toBe('king-kong-express');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
