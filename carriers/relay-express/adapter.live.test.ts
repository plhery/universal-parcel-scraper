import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.RELAY_EXPRESS_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected docket through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'relay-express' });
  expect(answer.source).toBe('relay-express');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
