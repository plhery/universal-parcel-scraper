import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.GLOBKURIER_TRACKING_NUMBER;

it.skipIf(!number)('tracks a published GlobKurier booking', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'globkurier' });
  expect(answer.source).toBe('globkurier');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
