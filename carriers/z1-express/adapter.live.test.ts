import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.Z1_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

// No place keeps a clock more than fourteen hours ahead of UTC.
const latestWallClock = () => new Date(Date.now() + 14 * 3_600_000).toISOString();

describe('Z1 Express live retrieval', () => {
  it('retrieves the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'z1-express' });
    expect(answer).toMatchObject({ carrier: 'z1-express', source: 'z1-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'z1-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Wordings on a wall clock, none past the latest clock anywhere, each step's name as its code.
    expect(result.events.every((event) => event.description && event.local_time && event.local_time <= latestWallClock())).toBe(true);
    expect(result.events.some((event) => event.provider_code && event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.Z1_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.Z1_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
