import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.LALJI_MULJI_TRACKING_NUMBER;

it.skipIf(!number)('tracks a published Lalji Mulji lorry receipt', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'lalji-mulji-transport' });
  expect(answer.source).toBe('lalji-mulji-transport');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
