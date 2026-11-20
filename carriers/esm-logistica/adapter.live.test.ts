import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.ESM_LOGISTICA_TRACKING_NUMBER;
const missing = process.env.ESM_LOGISTICA_MISSING_NUMBER;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('reads the delivered public guide and its dated delivery', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.status).toBe('delivered');
  expect(result.events).toContainEqual(expect.objectContaining({ stage: 'delivered' }));
}, 25_000);

it.skipIf(!missing)('recognizes the guest tracker’s explicit no-record response', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 25_000);
