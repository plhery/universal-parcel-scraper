import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.WARP_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('WARP live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'warp' });
    expect(answer).toMatchObject({ carrier: 'warp', source: 'warp' });
    expect(answer.attempts[0]).toMatchObject({ source: 'warp', kind: 'ok' });
    const { result } = answer;
    expect(result.provider_code).toMatch(/^[A-Za-z]{2,40}$/);
    // Events as instants, none in the future, each with WARP's status code.
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.provider_code && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.WARP_UNKNOWN_NUMBER ?? 'S-00000-0000' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
