import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public international sample, unless another number is given.
const NUMBER = process.env.SHIPAGENT_IN_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('ShipAgent live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'shipagent-in' });
    expect(answer).toMatchObject({ carrier: 'shipagent-in', source: 'shipagent-in' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shipagent-in', kind: 'ok' });
    const { result } = answer;
    expect(result.current_stage).toBeTruthy();
    // Rows on their wall clock, none in the future.
    expect(result.events.every((event) => event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.SHIPAGENT_IN_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SHIPAGENT_IN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
