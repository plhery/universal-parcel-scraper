import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const delivered = process.env.HULAK_TRACKING_NUMBER;
const other = process.env.HULAK_SECOND_NUMBER;

it.skipIf(!delivered)('finds the delivered consignment and its dated creation', async () => {
  const result = await tracker.track({ number: delivered! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'registered')).toBe(true);
}, 20_000);

it.skipIf(!other)('finds the carrier’s alternate reference format', async () => {
  const result = await tracker.track({ number: other! });
  expect(result.current_stage).toBeDefined();
  expect(result.events?.some(event => event.stage === 'registered')).toBe(true);
}, 20_000);
