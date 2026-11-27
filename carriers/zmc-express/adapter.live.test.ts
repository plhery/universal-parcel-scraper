import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another reference is given.
const NUMBER = process.env.ZMC_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;
const UNKNOWN = process.env.ZMC_EXPRESS_UNKNOWN_NUMBER;

describe('ZMC Express live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'zmc-express' });
    expect(answer).toMatchObject({ carrier: 'zmc-express', source: 'zmc-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'zmc-express', kind: 'ok' });
    const { result } = answer;
    expect(result.current_stage).toBeTruthy();
    // Scans on a branch's wall clock, dated on its zone, none ahead of the read.
    const now = new Date().toISOString();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.provider_code && event.local_time && event.time_zone && event.local_time <= now)).toBe(true);
  }, 45_000);

  it.skipIf(!UNKNOWN)('reads a reference the tracker holds no shipment under as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
