import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.AG_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('returns the verified delivery scan for AG Cargo’s published LR', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'delivered' && event.local_time)).toBe(true);
}, 20_000);
