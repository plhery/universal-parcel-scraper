import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The documentation's example number, unless another is given.
const NUMBER = process.env.ASL_TRACK_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('ASL Track live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'asl-track' });
    expect(answer).toMatchObject({ carrier: 'asl-track', source: 'asl-track' });
    expect(answer.attempts[0]).toMatchObject({ source: 'asl-track', kind: 'ok' });
    const { result } = answer;
    expect(result.current_stage).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);
    // Each scan has a wall clock or an instant, and none is in the future.
    expect(result.events.every((event) => (event.time ?? '') <= new Date().toISOString() && (event.local_time || event.time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ASL_TRACK_UNKNOWN_NUMBER ?? 'ASL12345678903' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
