import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.LISA_PARCEL_TRACKING_NUMBER;
const missing = process.env.LISA_PARCEL_MISSING_NUMBER;
const tracking = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns Lisa Parcel’s US warehouse movement and final delivery', async () => {
  const result = await tracking.track({ number: number! });
  expect(result.status).toBe('delivered');
  expect(result.events).toContainEqual(expect.objectContaining({ description: 'Left US warehouse' }));
  expect(result.events).toContainEqual(expect.objectContaining({ stage: 'delivered' }));
}, 20_000);

it.skipIf(!missing)('types an explicit no-record result from the guest service', async () => {
  await expect(tracking.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
