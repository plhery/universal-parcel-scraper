import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.AIRASIA_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('tracks an explicitly selected AirAsia Cargo waybill', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'airasia-cargo' });
  expect(answer.source).toBe('airasia-cargo');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
