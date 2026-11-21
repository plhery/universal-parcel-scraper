import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.SWISS_UNIVERSAL_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Swiss Universal Express live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'swiss-universal-express' });
    expect(answer).toMatchObject({ carrier: 'swiss-universal-express', source: 'swiss-universal-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'swiss-universal-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on their wall clock, in a year that puts none more than a day after the lookup.
    const latest = new Date(Date.now() + 86_400_000).toISOString();
    expect(result.events.every((event) => event.description && WALL_CLOCK.test(String(event.local_time)) && event.local_time! <= latest)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SWISS_UNIVERSAL_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SWISS_UNIVERSAL_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
