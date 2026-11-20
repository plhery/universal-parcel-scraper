import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.CITILINK_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('reads the published Citilink waybill movement history from public iCMS', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('in_transit');
  expect(result.provider_code).toBe('RCF');
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: 'RCS', location: 'SRG' }),
    expect.objectContaining({ provider_code: 'DEP', location: 'SRG' }),
    expect.objectContaining({ provider_code: 'RCF', location: 'BDJ' }),
  ]));
}, 20_000);
