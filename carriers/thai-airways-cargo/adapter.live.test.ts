import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.THAI_AIRWAYS_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('reads local movement times and destination delivery for a published THAI Cargo waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ description: 'Received from Shipper', local_time: expect.any(String) }),
    expect.objectContaining({ description: 'Departed', local_time: expect.any(String) }),
    expect.objectContaining({ description: 'Delivered', stage: 'delivered', local_time: expect.any(String) }),
  ]));
}, 22_000);
