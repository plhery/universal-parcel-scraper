import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.COPA_AIRLINES_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('tracks an explicitly selected Copa Airlines Cargo waybill', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'copa-airlines-cargo' });
  expect(answer.source).toBe('copa-airlines-cargo');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
