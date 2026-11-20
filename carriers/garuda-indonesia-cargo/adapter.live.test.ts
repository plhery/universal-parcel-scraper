import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.GARUDA_INDONESIA_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('reads dated receipt and departure from a published Garuda Cargo waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(['in_transit', 'delivered']).toContain(result.current_stage);
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: 'RCS', local_time: expect.any(String) }),
    expect.objectContaining({ provider_code: 'DEP', local_time: expect.any(String) }),
    expect.objectContaining({ provider_code: 'RCF', local_time: expect.any(String) }),
  ]));
}, 20_000);
