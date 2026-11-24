import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The first public sample, unless another number is given.
const NUMBER = process.env.COSHIP_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('COSHIP live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'coship' });
    expect(answer).toMatchObject({ carrier: 'coship', source: 'coship' });
    expect(answer.attempts[0]).toMatchObject({ source: 'coship', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every row keeps its day or wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.COSHIP_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: '도착' });
      expect(result.events.map((event) => event.location)).toEqual(['INCHEON AIRPORT', 'VANCOUVER AIRPORT', 'VANCOUVER']);
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.COSHIP_UNKNOWN_NUMBER ?? '0000000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
