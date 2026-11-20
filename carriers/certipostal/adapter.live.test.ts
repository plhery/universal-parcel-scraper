import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const { CERTIPOSTAL_TRACKING_NUMBER: delivered, CERTIPOSTAL_RETURNED_NUMBER: returned } = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!delivered)('returns the public Certipostal guide with its delivery scan', async () => {
  const result = await tracker.track({ number: delivered! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.length).toBeGreaterThan(1);
}, 20_000);

it.skipIf(!returned)('returns the physical return from the public guest tracker', async () => {
  const result = await tracker.track({ number: returned! });
  expect(result.current_stage).toBe('exception');
  expect(result.events?.some(event => event.description === 'DISTRIBUCION')).toBe(true);
}, 20_000);
