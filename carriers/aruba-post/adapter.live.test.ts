import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.ARUBA_POST_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected item through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'aruba-post' });
  expect(answer.source).toBe('aruba-post');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
