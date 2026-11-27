import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another order number is given.
const NUMBER = process.env.RYDER_LAST_MILE_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Ryder Last Mile live retrieval', () => {
  it('retrieves the requested order and its events with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'ryder-last-mile' });
    expect(answer).toMatchObject({ carrier: 'ryder-last-mile', source: 'ryder-last-mile' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ryder-last-mile', kind: 'ok' });
    const { result } = answer;
    expect(result.provider_code).toMatch(/^[a-z_]+$/);
    // Events at the offsets the widget states, none in the future.
    expect(result.events.every((event) => event.time && /[+-]\d{2}:\d{2}$/.test(event.time) && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown order as not found', async () => {
    await expect(direct().track({ number: process.env.RYDER_LAST_MILE_UNKNOWN_NUMBER ?? 'ZZ99887766' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
