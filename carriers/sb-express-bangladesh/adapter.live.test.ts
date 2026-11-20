import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.SB_EXPRESS_TRACKING_NUMBER;

it.skipIf(!number)('reads the carrier-published parcel and its pickup and hub movements', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBeDefined();
  expect(result.events?.some(event => event.description === 'Hub received')).toBe(true);
  expect(result.events?.some(event => event.stage === 'accepted')).toBe(true);
}, 20_000);
