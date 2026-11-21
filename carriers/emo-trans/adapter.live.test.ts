import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.EMO_TRANS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('EMO Trans live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'emo-trans' });
    expect(answer).toMatchObject({ carrier: 'emo-trans', source: 'emo-trans' });
    expect(answer.attempts[0]).toMatchObject({ source: 'emo-trans', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toBeTruthy();
    // Events on their station's wall clock.
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    const unknown = process.env.EMO_TRANS_UNKNOWN_NUMBER ?? 'S2601A99999990';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
