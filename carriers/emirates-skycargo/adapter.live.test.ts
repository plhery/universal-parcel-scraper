import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.EMIRATES_SKYCARGO_TRACKING_NUMBER;
const unknown = process.env.EMIRATES_SKYCARGO_UNKNOWN_NUMBER;

it.skipIf(!number)('reads the stations and flights of an Emirates SkyCargo waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: expect.stringMatching(/^[A-Z]{3,4}$/), location: expect.stringMatching(/^[A-Z]{3}$/) }),
  ]));
}, 25_000);

it.skipIf(!unknown)('answers a waybill without a booking as not found', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 25_000);
