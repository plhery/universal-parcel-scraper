import { expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';

const code = process.env.FRAKTJAKT_TRACKING_CODE;

it.skipIf(!code)('tracks a published Fraktjakt shipment code', async () => {
  const answer = await createTracker({ providers: [] }).track({ number: code!, carrier: 'fraktjakt' });
  expect(answer.source).toBe('fraktjakt');
  expect(answer.result.events.length).toBeGreaterThan(0);
}, 30_000);
