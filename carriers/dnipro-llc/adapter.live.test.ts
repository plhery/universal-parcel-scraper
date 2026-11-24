import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The first public sample, unless another number is given.
const NUMBER = process.env.DNIPRO_LLC_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Dnipro LLC live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'dnipro-llc' });
    expect(answer).toMatchObject({ carrier: 'dnipro-llc', source: 'dnipro-llc' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dnipro-llc', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every event keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.DNIPRO_LLC_TRACKING_NUMBER) {
      expect(result.events.at(-1)).toMatchObject({ local_time: '2026-05-22T09:57:32', provider_code: '1', stage: 'registered' });
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.DNIPRO_LLC_UNKNOWN_NUMBER ?? 'DN123456789' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
