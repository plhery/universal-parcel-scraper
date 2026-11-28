import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.DYEXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Dayi Express live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'dyexpress' });
    expect(answer).toMatchObject({ carrier: 'dyexpress', source: 'dyexpress' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dyexpress', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 45_000);

  it('reads an unknown number as not found', async () => {
    const unknown = process.env.DYEXPRESS_UNKNOWN_NUMBER ?? '5930264817';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
