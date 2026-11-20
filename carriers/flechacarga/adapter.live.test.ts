import { expect, it } from 'vitest';
import { FlechaCargaTracker } from './adapter.js';
const number = process.env.FLECHACARGA_NUMBER;
it.skipIf(!number)('reads a legacy FlechaCarga receipt supplied outside Git', async () => {
  const result = await new FlechaCargaTracker().fetch(number!, { budgetMs: 25_000 });
  expect(result.events?.length).toBeGreaterThan(0);
}, 30_000);
