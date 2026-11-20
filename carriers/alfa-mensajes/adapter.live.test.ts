import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { ALFA_MENSAJES_TRACKING_NUMBER: found, ALFA_MENSAJES_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads dated movements for the published Alfa Mensajes guide', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
}, 35_000);

it.skipIf(!unknown)('returns not-found for an unknown physical guide', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 35_000);
