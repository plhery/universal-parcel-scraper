import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The first public sample, unless another number is given.
const NUMBER = process.env.TOPPARCEL_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Topparcel live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'topparcel' });
    expect(answer).toMatchObject({ carrier: 'topparcel', source: 'topparcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'topparcel', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on their wall clock, none in the future.
    expect(result.events.every((event) => event.description && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.TOPPARCEL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TOPPARCEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
