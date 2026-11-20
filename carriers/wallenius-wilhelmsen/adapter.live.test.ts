import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const { TRACKING_CHROMIUM_PATH: browserExecutablePath, WALLENIUS_WILHELMSEN_TRACKING_NUMBER: number } = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: browserExecutablePath ?? null });

it.skipIf(!number || !browserExecutablePath)('uses the public BOL form and returns the carrier’s dated movements', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(1);
}, 45_000);
