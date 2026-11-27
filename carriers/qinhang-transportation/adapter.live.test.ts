import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.QINHANG_TRANSPORTATION_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Qinhang Transportation live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'qinhang-transportation' });
    expect(answer).toMatchObject({ carrier: 'qinhang-transportation', source: 'qinhang-transportation' });
    expect(answer.attempts[0]).toMatchObject({ source: 'qinhang-transportation', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.QINHANG_TRANSPORTATION_UNKNOWN_NUMBER ?? 'QH99999999';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
