import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.POLAR_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Polar Express live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'polar-express' });
    expect(answer).toMatchObject({ carrier: 'polar-express', source: 'polar-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'polar-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on their wall clock, none in the future.
    expect(result.events.every((event) => event.description && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.POLAR_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.POLAR_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
