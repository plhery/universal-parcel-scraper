import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.HERONA_EXPRESS_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected shipment through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'herona-express' });
  expect(answer.source).toBe('herona-express');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
