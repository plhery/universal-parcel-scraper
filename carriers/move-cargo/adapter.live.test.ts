import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.MOVE_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('tracks an explicitly selected Move Cargo reference', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'move-cargo' });
  expect(answer.source).toBe('move-cargo');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
