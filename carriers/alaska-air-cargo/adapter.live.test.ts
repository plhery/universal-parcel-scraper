import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.ALASKA_AIR_CARGO_TRACKING_NUMBER;
const unknown = process.env.ALASKA_AIR_CARGO_UNKNOWN_NUMBER;

it.skipIf(!number)('reads the stations of a current Alaska Air Cargo waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ local_time: expect.any(String), location: expect.stringMatching(/^[A-Z]{3}$/) }),
  ]));
}, 20_000);

it.skipIf(!unknown)('answers a waybill the portal does not hold as not found', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
