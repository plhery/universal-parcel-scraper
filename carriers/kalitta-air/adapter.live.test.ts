import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.KALITTA_AIR_TRACKING_NUMBER;

it.skipIf(!number)('reads the customs and station messages of a published Kalitta Air waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(['in_transit', 'customs', 'ready_for_pickup', 'delivered']).toContain(result.current_stage);
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: expect.stringMatching(/^[a-z]+$/), local_time: expect.any(String), location: expect.stringMatching(/^[A-Z]{3}$/) }),
  ]));
}, 20_000);
