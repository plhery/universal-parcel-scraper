import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.YHTLOGISTICS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Shanghai Aerospace Logistics live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'yhtlogistics' });
    expect(answer).toMatchObject({ carrier: 'yhtlogistics', source: 'yhtlogistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'yhtlogistics', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('签收人');
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.YHTLOGISTICS_UNKNOWN_NUMBER ?? '999999999990';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
