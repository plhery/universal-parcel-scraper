import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { ACT_LOGISTICS_TRACKING_NUMBER: found, ACT_LOGISTICS_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads a waybill bound to the whole number', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
}, 20_000);

it.skipIf(!unknown)('reads the explicit absence reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
