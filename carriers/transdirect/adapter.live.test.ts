import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.TRANSDIRECT_TRACKING_NUMBER;

it.skipIf(!number)('tracks the explicitly selected Transdirect consignment', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'transdirect' });
  expect(answer.source).toBe('transdirect');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
