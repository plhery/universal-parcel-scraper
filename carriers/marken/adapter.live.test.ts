import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.MARKEN_TRACKING_NUMBER;

it.skipIf(!number)('tracks a published Marken job', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'marken' });
  expect(answer.source).toBe('marken');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
