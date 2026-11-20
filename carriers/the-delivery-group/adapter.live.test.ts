import { expect, it } from 'vitest';
import { TheDeliveryGroupTracker } from './adapter.js';

const number = process.env.THE_DELIVERY_GROUP_NUMBER;
it.skipIf(!number)('reads a TDG parcel supplied outside Git', async () => {
  const result = await new TheDeliveryGroupTracker().fetch(number!, process.env.THE_DELIVERY_GROUP_POSTCODE ?? '', { budgetMs: 20_000 });
  expect(result.events?.length).toBeGreaterThan(0);
}, 25_000);
