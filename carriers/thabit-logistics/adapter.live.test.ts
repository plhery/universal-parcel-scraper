import { expect, it } from 'vitest';
import { ThabitTracker } from './adapter.js';
import { TrawlClient } from '../../core/transport/trawl.js';
const number = process.env.THABIT_NUMBER;
it.skipIf(!number)('reads a whole-bound Thabit guest history', async () => {
  const result = await new ThabitTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(number!, { budgetMs: 60_000 });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.every(event => /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time ?? ''))).toBe(true);
}, 65_000);
