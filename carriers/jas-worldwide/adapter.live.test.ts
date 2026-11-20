import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.JAS_WORLDWIDE_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected shipment through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'jas-worldwide' });
  expect(answer.source).toBe('jas-worldwide');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
