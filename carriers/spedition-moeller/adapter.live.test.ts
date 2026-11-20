import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.MOELLER_TRACKING_NUMBER;

it.skipIf(!number)('tracks the published Artur Möller package barcode', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'spedition-moeller' });
  expect(answer.source).toBe('spedition-moeller');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
