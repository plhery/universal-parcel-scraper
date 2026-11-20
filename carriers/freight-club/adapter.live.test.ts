import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.FREIGHT_CLUB_TRACKING_NUMBER;

it.skipIf(!number)('tracks a published Freight Club booking', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'freight-club' });
  expect(answer.source).toBe('freight-club');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
