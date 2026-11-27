import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The domestic public sample, unless another number is given.
const NUMBER = process.env.IBEROMAIL_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Iberomail live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'iberomail' });
    expect(answer).toMatchObject({ carrier: 'iberomail', source: 'iberomail' });
    expect(answer.attempts[0]).toMatchObject({ source: 'iberomail', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on their wall clock, none in the future.
    expect(result.events.every((event) => event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.IBEROMAIL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.IBEROMAIL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
