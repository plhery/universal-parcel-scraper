import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const number = process.env.FLASHPY_TRACKING_NUMBER;

it.skipIf(!number)('tracks the published handoff reference through explicit carrier selection', async () => {
  const tracker = createTracker({ providers: [] });
  const { carrier, source, result } = await tracker.track({ carrier: 'flashpy', number: number! });
  expect(carrier).toBe('flashpy');
  expect(source).toBe('flashpy');
  expect(result.events).toContainEqual(expect.objectContaining({
    description: 'Proceso Internacional', stage: 'in_transit',
  }));
}, 20_000);
