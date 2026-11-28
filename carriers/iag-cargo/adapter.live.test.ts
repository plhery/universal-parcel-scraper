import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.IAG_CARGO_TRACKING_NUMBER;
// A public British Airways waybill the tracker no longer holds.
const unknown = process.env.IAG_CARGO_UNKNOWN_NUMBER ?? '125-47701614';

it.skipIf(!number)('reads the stations and flights of a current IAG Cargo waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider_code: expect.stringMatching(/^[A-Z]{3,9}$/), location: expect.stringMatching(/^[A-Z]{3}$/) }),
  ]));
}, 20_000);

it('answers a waybill the tracker does not hold as not found', async () => {
  await expect(tracker.track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
