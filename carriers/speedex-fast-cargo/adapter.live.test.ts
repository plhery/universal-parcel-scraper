import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.SPEEDEX_FAST_CARGO_TRACKING_NUMBER;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns the delivery and dated movements for the carrier’s published docket', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.description === 'Outscan')).toBe(true);
}, 20_000);
