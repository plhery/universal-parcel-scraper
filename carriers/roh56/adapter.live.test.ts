import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.ROH56_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Ronghui Supply Chain live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'roh56' });
    expect(answer).toMatchObject({ carrier: 'roh56', source: 'roh56' });
    expect(answer.attempts[0]).toMatchObject({ source: 'roh56', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.ROH56_UNKNOWN_NUMBER ?? 'RH99999999';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
