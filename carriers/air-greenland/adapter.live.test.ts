import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.AIR_GREENLAND_TRACKING_NUMBER;

it.skipIf(!number)('tracks an explicitly selected Air Greenland waybill', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'air-greenland' });
  expect(answer.source).toBe('air-greenland');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
