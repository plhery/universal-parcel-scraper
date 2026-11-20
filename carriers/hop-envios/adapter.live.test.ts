import { expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const number = process.env.HOP_ENVIOS_TRACKING_NUMBER;
const unknown = process.env.HOP_ENVIOS_UNKNOWN_NUMBER;
it.skipIf(!number)('reads the selected shipment through the SDK', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'hop-envios' });
  expect(answer.source).toBe('hop-envios');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);

it.skipIf(!unknown)('recognizes the current tracker’s explicit absence reply', async () => {
  const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: unknown! })).rejects.toThrow(NotFoundError);
}, 30_000);
