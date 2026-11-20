import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.AKR_EXPRESS_TRACKING_NUMBER;

it.skipIf(!number)('tracks a published AKR Express lorry receipt', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'akr-express' });
  expect(answer.source).toBe('akr-express');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
