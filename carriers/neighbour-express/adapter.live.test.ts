import { expect, it } from 'vitest';
import { createTracker, TrackingError } from '../../facade/index.js';

const number = process.env.NEIGHBOUR_TRACKING_NUMBER;
it.skipIf(!number)('reads a supplied Neighbour Express return through the browser service', async () => {
  const result = await createTracker({ providers: [] }).track({ number: number!, carrier: 'neighbour-express' }, { budgetMs: 75000 });
  expect(result.result.events?.length).toBeGreaterThan(0);
}, 80000);

const unknown = process.env.NEIGHBOUR_UNKNOWN_NUMBER;
it.skipIf(!unknown)('keeps an unknown return inconclusive while verification is unresolved', async () => {
  const outcome = await createTracker({ providers: [] }).track({ number: unknown!, carrier: 'neighbour-express' }, { budgetMs: 75000 })
    .then(() => 'history', (error: unknown) => error instanceof TrackingError ? error.hint.kind : 'untyped');
  expect(['challenge', 'indeterminate']).toContain(outcome);
}, 80000);
