import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { AIR_ARABIA_CARGO_TRACKING_NUMBER: found, AIR_ARABIA_CARGO_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads the history of a published Air Arabia Cargo waybill with station offsets', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: 'RCS', time: expect.stringMatching(/[+-]\d{2}:\d{2}$/) }),
    expect.objectContaining({ provider_code: 'DEP', time: expect.stringMatching(/[+-]\d{2}:\d{2}$/) }),
  ]));
}, 20_000);

it.skipIf(!unknown)('reads the not-found code as not found', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
