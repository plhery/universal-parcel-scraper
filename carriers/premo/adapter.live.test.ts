import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.PREMO_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Premo live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'premo' });
    expect(answer).toMatchObject({ carrier: 'premo', source: 'premo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'premo', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every event keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.PREMO_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Ditt paket har nu levererats med Premos tidningsbud' });
      expect(result.events).toHaveLength(3);
    }
  }, 45_000);

  it('reads a number the page does not know as not found', async () => {
    await expect(direct().track({ number: process.env.PREMO_UNKNOWN_NUMBER ?? 'PR9900000000017' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
