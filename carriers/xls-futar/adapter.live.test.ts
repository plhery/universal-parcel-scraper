import { expect, it } from 'vitest';
import { XlsFutarTracker } from './adapter.js';

const number = process.env.XLS_FUTAR_TEST_NUMBER;
it.runIf(!!number)('reads an XLS Futár public summary', async () => {
  const result = await new XlsFutarTracker().fetch(number!, { budgetMs: 15_000 });
  expect(result.summary_only).toBe(true);
  expect(result.last_status_text).toBeTruthy();
  expect(result.last_update_local).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
  expect(result.events).toEqual([]);
}, 20_000);
