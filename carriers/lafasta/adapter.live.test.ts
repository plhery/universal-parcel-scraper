import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.LAFASTA_TRACKING_NUMBER;
it.skipIf(!number)('reads the selected shipment through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'lafasta' });
  expect(answer.source).toBe('lafasta');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
