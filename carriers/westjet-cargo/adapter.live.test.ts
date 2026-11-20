import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.WESTJET_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('tracks an explicitly selected WestJet Cargo waybill', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'westjet-cargo' });
  expect(answer.source).toBe('westjet-cargo');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
