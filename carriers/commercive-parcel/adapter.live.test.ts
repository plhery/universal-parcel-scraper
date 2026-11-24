import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracker's example number, unless another is given.
const NUMBER = process.env.COMMERCIVE_PARCEL_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Commercive Parcel live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'commercive-parcel' });
    expect(answer).toMatchObject({ carrier: 'commercive-parcel', source: 'commercive-parcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'commercive-parcel', kind: 'ok' });
    const { result } = answer;
    expect(result.current_stage).toBeTruthy();
    // Scans as instants, none in the future.
    expect(result.events.every((event) => event.time && event.time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.COMMERCIVE_PARCEL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.COMMERCIVE_PARCEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
