import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The help centre's delivered example, unless another number is given.
const NUMBER = process.env.BARQ_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('BARQ live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'barq' });
    expect(answer).toMatchObject({ carrier: 'barq', source: 'barq' });
    expect(answer.attempts[0]).toMatchObject({ source: 'barq', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every log keeps the offset BARQ states.
    for (const event of result.events) expect(event.time).toMatch(/[+-]\d{2}:\d{2}$/);
    if (!process.env.BARQ_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Completed' });
      expect(result.events.map((event) => event.provider_code)).toEqual(['completed', 'intransit', 'picked_up', 'ready_for_delivery']);
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.BARQ_UNKNOWN_NUMBER ?? 'ZZ000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
