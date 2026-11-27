import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.CHINASTARLOGISTICS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Huaxin Supply Chain live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'chinastarlogistics' });
    expect(answer).toMatchObject({ carrier: 'chinastarlogistics', source: 'chinastarlogistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'chinastarlogistics', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 45_000);

  it('reads an unknown number as not found', async () => {
    const unknown = process.env.CHINASTARLOGISTICS_UNKNOWN_NUMBER ?? 'YGZS1999010199999';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
