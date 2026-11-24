import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.ROSS_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Ross Express live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'ross-express' });
    expect(answer).toMatchObject({ carrier: 'ross-express', source: 'ross-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ross-express', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every row keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.ROSS_EXPRESS_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
      expect(result.events.at(-1)).toMatchObject({ description: 'Loaded On Trailer', location: 'Auburn, MA' });
    }
  }, 45_000);

  it('reads the trace’s answer for an invented PRO as not found', async () => {
    await expect(direct().track({ number: '0000001' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
