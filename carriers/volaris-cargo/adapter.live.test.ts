import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.VOLARIS_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('returns the native Volaris flight and delivery movements', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ description: 'Departed', stage: 'in_transit' }),
    expect.objectContaining({ description: 'Delivered', location: 'MID', stage: 'delivered' }),
  ]));
}, 20_000);
