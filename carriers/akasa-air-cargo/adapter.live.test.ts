import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.AKASA_AIR_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('tracks the explicitly selected Akasa Air cargo waybill', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'akasa-air-cargo' });
  expect(answer.source).toBe('akasa-air-cargo');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
