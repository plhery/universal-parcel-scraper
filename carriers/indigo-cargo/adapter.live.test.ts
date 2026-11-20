import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.INDIGO_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('tracks the explicitly selected IndiGo master waybill', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'indigo-cargo' });
  expect(answer.source).toBe('indigo-cargo');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
