import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.RECIBELO_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Recíbelo live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'recibelo' });
    expect(answer).toMatchObject({ carrier: 'recibelo', source: 'recibelo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'recibelo', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.RECIBELO_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Completado', last_update_local: '2024-06-21T18:36:31' });
      expect(result.events).toHaveLength(4);
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.RECIBELO_UNKNOWN_NUMBER ?? '900000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
