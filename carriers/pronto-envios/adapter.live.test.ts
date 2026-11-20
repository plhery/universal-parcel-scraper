import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const { PRONTO_ENVIOS_TRACKING_NUMBER: number, PRONTO_ENVIOS_MISSING_NUMBER: missing } = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns dated movements for a public Pronto Envíos guide', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(1);
}, 20_000);

it.skipIf(!missing)('reports a published guide currently absent from the native tracker', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
