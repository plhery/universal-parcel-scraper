import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another consignment number is given.
const NUMBER = process.env.COPE_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('COPE Sensitive Freight live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'cope-sensitive-freight' });
    expect(answer).toMatchObject({ carrier: 'cope-sensitive-freight', source: 'cope-sensitive-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'cope-sensitive-freight', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on a wall clock without an offset, none in the future, each with its stage column as its code.
    expect(result.events.every((event) => event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))
      && String(event.local_time) <= new Date().toISOString())).toBe(true);
  }, 45_000);

  it('reads a number COPE does not know as not found', async () => {
    await expect(direct().track({ number: process.env.COPE_UNKNOWN_NUMBER ?? 'ZZQ0000001' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
