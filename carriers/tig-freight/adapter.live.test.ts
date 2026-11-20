import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.TIG_FREIGHT_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected Open360 shipment through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'tig-freight' });
  expect(answer.source).toBe('tig-freight');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
