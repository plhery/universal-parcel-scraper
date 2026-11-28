import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.HUAXINTAI_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Huaxintai Logistics live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'huaxintai' });
    expect(answer).toMatchObject({ carrier: 'huaxintai', source: 'huaxintai' });
    expect(answer.attempts[0]).toMatchObject({ source: 'huaxintai', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 45_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.HUAXINTAI_UNKNOWN_NUMBER ?? '982731';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
