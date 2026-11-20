import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.SFL_WORLDWIDE_TRACKING_NUMBER;
const missing = process.env.SFL_WORLDWIDE_TRACKING_MISSING;

it.skipIf(!number)('reads the SFL Worldwide delivery summary and dated handoff', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events).toContainEqual(expect.objectContaining({
    local_time: '2025-09-19T07:54:34', description: 'Shipment has been connected via Blue Dart',
  }));
}, 20_000);

it.skipIf(!missing)('recognizes the current native no-match response', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
