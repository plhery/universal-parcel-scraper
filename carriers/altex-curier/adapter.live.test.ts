import { expect, it } from 'vitest';
import { AltexCurierTracker } from './adapter.js';

const number = process.env.ALTEX_CURIER_NUMBER;
it.skipIf(!number)('reads an Altex Curier AWB supplied outside Git', async () => {
  const result = await new AltexCurierTracker().fetch(number!, { budgetMs: 20_000 });
  expect(result.events?.length).toBeGreaterThan(0);
}, 25_000);
