import { expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { SeinoSuperExpressTracker } from './adapter.js';

const number = process.env.SEINO_SUPER_EXPRESS_LIVE_NUMBER;
const unknown = process.env.SEINO_SUPER_EXPRESS_LIVE_UNKNOWN;
it.skipIf(!number)('retrieves the SSX guest detail history and optional unknown', async () => {
  const tracker = new SeinoSuperExpressTracker();
  const result = await tracker.fetch(number!);
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.every(e => typeof e.provider_time_text === 'string' && e.time === undefined && e.local_time === undefined)).toBe(true);
  expect(result.history_truncated).toBe(true);
  if (unknown) await expect(tracker.fetch(unknown)).rejects.toBeInstanceOf(NotFoundError);
});
