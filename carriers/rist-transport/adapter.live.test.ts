import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const first = process.env.RIST_TRANSPORT_TRACKING_NUMBER;
const second = process.env.RIST_TRANSPORT_SECOND_NUMBER;

it.skipIf(!first)('returns delivery and pickup on the first published PRO', async () => {
  const result = await tracker.track({ number: first! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'accepted')).toBe(true);
}, 20_000);

it.skipIf(!second)('tracks the historical PRO shown with an additional suffix', async () => {
  const result = await tracker.track({ number: second! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.description === 'Inbound Unloaded')).toBe(true);
}, 20_000);
