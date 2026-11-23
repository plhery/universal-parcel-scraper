import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SRILANKAN_CARGO_TRACKING_NUMBER: found, SRILANKAN_CARGO_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('reads the activity of a published SriLankan Cargo waybill on station clocks', async () => {
  const result = await tracker.track({ number: found! });
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: 'RCS', local_time: expect.any(String) }),
    expect.objectContaining({ provider_code: 'DEP', local_time: expect.any(String) }),
  ]));
}, 25_000);

it.skipIf(!unknown)('reads an empty guest answer as not found', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 25_000);
