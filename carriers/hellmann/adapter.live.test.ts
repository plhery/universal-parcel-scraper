import { expect, it } from 'vitest';
import { HellmannTracker } from './adapter.js';

const number = process.env.HELLMANN_NUMBER;
it.skipIf(!number)('reads a whole-bound anonymous Hellmann road package summary', async () => {
  const result = await new HellmannTracker().fetch(number!, { budgetMs: 20_000 });
  expect(result.summary_only).toBe(true);
  expect(result.events).toEqual([]);
  expect(result.last_update_local).toMatch(/^20\d{2}-\d{2}-\d{2}T/);
}, 25_000);
