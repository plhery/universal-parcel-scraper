import { expect, it } from 'vitest';
import { HonducorTracker } from './adapter.js';

const number = process.env.HONDUCOR_TEST_NUMBER;
it.runIf(!!number)('reads Honducor guest history', async () => {
  const result = await new HonducorTracker().fetch(number!, { budgetMs: 45_000 });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.every(event => event.local_time && event.description)).toBe(true);
}, 50_000);
