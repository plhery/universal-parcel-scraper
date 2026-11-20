import { expect, it } from 'vitest';
import { TramacoTracker } from './adapter.js';

const number = process.env.TRAMACO_NUMBER;
it.skipIf(!number)('reads a Tramaco guide supplied outside Git', async () => {
  const result = await new TramacoTracker().fetch(number!, { budgetMs: 20_000 });
  expect(result.events?.length).toBeGreaterThan(0);
}, 25_000);
