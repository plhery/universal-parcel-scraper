import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.PACIFIC_AIR_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('reads dated receipt, departure and arrival records from PACTRAK', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('in_transit');
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ description: 'Shipment Received', location: 'LAX' }),
    expect.objectContaining({ description: 'Flight Departed', location: 'LAX' }),
    expect.objectContaining({ description: 'Flight Arrived', location: 'HNL' }),
  ]));
}, 20_000);
